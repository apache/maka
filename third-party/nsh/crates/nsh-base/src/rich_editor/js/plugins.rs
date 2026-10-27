//! Plugins from TS: the kernel's (`history()`, `keymap({...})`,
//! `inputRules([...])`, `markdown()`, `starterKit()`) as data resolved
//! against the editor's schema, and `RichEditorPlugin`, a plugin whose
//! hooks are the app's functions.
//!
//! The hooks never sit on the input path: keys a JS plugin captures are
//! consumed natively while it says so (`setCapturing`) and JS hears of them
//! afterwards; its decorations are data it hands over, mapped natively
//! through every change; `filterTransaction` / `appendTransaction` run
//! synchronously only for transactions the app's own calls make (`run`,
//! `dispatch`, `setContent`, ...), where JS is running anyway. Typing and
//! the platform's input are never held up for JS.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::ThreadId,
};

use nsh_core::{
    JsonValue,
    element::{Arg, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, Ret, TsTypes},
    prelude::*,
};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::{
    commands::{RichCommand, attrs_of, resolve},
    json::{AttrsJson, StateJson, TransactionJson},
};
use crate::rich_editor::{
    commands::{BoxCommand, base_keymap, command},
    extensions::{
        HistoryOptions, InputRule, Keymap, KeymapOptions, ellipsis, em_dash, history, input_rules,
        keymap_plugin, mark_input_rule,
        markdown::{self, MarkdownOptions},
        smart_quotes, starter, textblock_type_input_rule, wrapping_input_rule,
    },
    model::{Attrs, Schema},
    state::{
        Decoration, DecorationSet, EditorState, KeyEvent, Plugin, PluginKey, PluginSpec,
        PluginState, Selection, Transaction, TransactionOrigin,
    },
};

// --- Calls from JS ---------------------------------------------------------

thread_local! {
    /// How deep the engine thread is in a synchronous call from JS into
    /// the editor's API: hooks are called on the spot only then.
    static IN_CALL: Cell<u32> = const { Cell::new(0) };
}

/// Marks a synchronous call from JS into the editor's API while it lives.
pub(crate) struct CallGuard(());

impl CallGuard {
    pub(crate) fn enter() -> Self {
        IN_CALL.with(|depth| depth.set(depth.get() + 1));
        Self(())
    }
}

impl Drop for CallGuard {
    fn drop(&mut self) {
        IN_CALL.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

/// Whether JS is running a synchronous call into the editor's API on this
/// thread (so a callback may be called now).
pub(crate) fn in_js_call() -> bool {
    IN_CALL.with(|depth| depth.get() > 0)
}

// --- The app's functions, kept on the engine thread --------------------------

// appendTransaction: the transactions so far and the state, to what it
// appends.
type AppendHook = Callback<(Vec<TransactionJson>, StateJson), Option<TransactionJson>>;

/// The JS functions of one plugin or editor. Callbacks are the engine
/// thread's (`Rc`), while the kernel's plugins and the session are `Send +
/// Sync`: they hold a [`HookRef`], and the functions stay here, in a table
/// of the thread that made them.
#[derive(Default, Clone)]
pub(crate) struct Hooks {
    pub(crate) filter: Option<Callback<TransactionJson, bool>>,
    pub(crate) append: Option<AppendHook>,
    pub(crate) keys: Option<Callback<String>>,
    pub(crate) dispatch: Option<Callback<TransactionJson>>,
    pub(crate) update: Option<Callback<f64>>,
}

thread_local! {
    static HOOKS: RefCell<HashMap<u64, Hooks>> = RefCell::new(HashMap::new());
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// A handle of a [`Hooks`] entry, usable from any thread: only the thread
/// that made it reaches the functions; dropping the last handle there
/// releases them.
#[derive(Debug)]
pub(crate) struct HookRef {
    id: u64,
    thread: ThreadId,
}

impl HookRef {
    pub(crate) fn new() -> Arc<Self> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        HOOKS.with(|hooks| hooks.borrow_mut().insert(id, Hooks::default()));
        Arc::new(Self {
            id,
            thread: std::thread::current().id(),
        })
    }

    /// The functions (cloned out, so a call into JS holds no borrow), when
    /// on the thread that made them.
    pub(crate) fn get(&self) -> Option<Hooks> {
        if std::thread::current().id() != self.thread {
            return None;
        }
        HOOKS.with(|hooks| hooks.borrow().get(&self.id).cloned())
    }

    /// Changes the functions (on the thread that made them).
    pub(crate) fn update(&self, f: impl FnOnce(&mut Hooks)) {
        if std::thread::current().id() != self.thread {
            return;
        }
        HOOKS.with(|hooks| {
            if let Some(entry) = hooks.borrow_mut().get_mut(&self.id) {
                f(entry);
            }
        });
    }
}

impl Drop for HookRef {
    fn drop(&mut self) {
        // Elsewhere the functions stay until the VM goes (they are freed
        // with it).
        if std::thread::current().id() == self.thread {
            let _ = HOOKS.try_with(|hooks| {
                if let Ok(mut hooks) = hooks.try_borrow_mut() {
                    hooks.remove(&self.id)
                } else {
                    None
                }
            });
        }
    }
}

// --- Transactions as JSON -----------------------------------------------------

fn origin_json(origin: &TransactionOrigin) -> String {
    match origin {
        TransactionOrigin::User => "user".into(),
        TransactionOrigin::Input => "input".into(),
        TransactionOrigin::Paste => "paste".into(),
        TransactionOrigin::Drop => "drop".into(),
        TransactionOrigin::Remote(who) => format!("remote:{who}"),
        TransactionOrigin::History => "history".into(),
        TransactionOrigin::Plugin(key) => format!("plugin:{key}"),
        _ => "api".into(),
    }
}

fn origin_from(text: &str) -> TransactionOrigin {
    match text {
        "user" => TransactionOrigin::User,
        "input" => TransactionOrigin::Input,
        "paste" => TransactionOrigin::Paste,
        "drop" => TransactionOrigin::Drop,
        "history" => TransactionOrigin::History,
        other => match other.split_once(':') {
            Some(("remote", who)) => TransactionOrigin::Remote(who.to_owned()),
            Some(("plugin", key)) => TransactionOrigin::Plugin(key.to_owned()),
            _ => TransactionOrigin::Api,
        },
    }
}

/// `tr`'s JSON form (`id`: the editor's id while it waits to be applied).
pub(crate) fn transaction_json(tr: &Transaction, id: Option<u64>) -> TransactionJson {
    let mut out = Map::new();
    out.insert(
        "steps".into(),
        Value::Array(tr.steps.iter().map(|step| step.to_json()).collect()),
    );
    if tr.selection_set() {
        out.insert("selection".into(), tr.selection().to_json());
    }
    if tr.stored_marks_set() {
        out.insert(
            "storedMarks".into(),
            tr.stored_marks().map_or(Value::Null, |marks| {
                Value::Array(marks.iter().map(|mark| mark.to_json()).collect())
            }),
        );
    }
    let meta: Map<String, Value> = tr
        .meta_entries()
        .map(|(key, value)| (key.to_owned(), value.clone()))
        .collect();
    if !meta.is_empty() {
        out.insert("meta".into(), Value::Object(meta));
    }
    if let Some(origin) = tr.origin() {
        out.insert("origin".into(), Value::String(origin_json(origin)));
    }
    out.insert("docChanged".into(), Value::Bool(tr.doc_changed()));
    out.insert("time".into(), json!(tr.time));
    if let Some(id) = id {
        out.insert("id".into(), json!(id));
    }
    TransactionJson(Value::Object(out))
}

/// A transaction of `state` from its JSON form (steps against `state`'s
/// document). Its origin is the API's unless it names one.
pub(crate) fn transaction_from_json(
    state: &EditorState,
    json: &JsonValue,
) -> Result<Transaction, String> {
    let schema = state.schema();
    let mut tr = state.tr();
    for step in json
        .get("steps")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let step = crate::rich_editor::transform::step_from_json(schema, step)
            .map_err(|e| e.to_string())?;
        tr.step(step).map_err(|e| e.to_string())?;
    }
    if let Some(selection) = json.get("selection").filter(|s| !s.is_null()) {
        let selection = Selection::from_json(tr.doc(), selection).map_err(|e| e.to_string())?;
        tr.set_selection(selection);
    }
    match json.get("storedMarks") {
        Some(Value::Null) => {
            tr.set_stored_marks(None);
        }
        Some(Value::Array(marks)) => {
            let marks = marks
                .iter()
                .map(|mark| schema.mark_from_json(mark).map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, _>>()?;
            tr.set_stored_marks(Some(marks));
        }
        _ => {}
    }
    if let Some(Value::Object(meta)) = json.get("meta") {
        for (key, value) in meta {
            tr.set_meta(key, value.clone());
        }
    }
    let origin = json
        .get("origin")
        .and_then(Value::as_str)
        .map_or(TransactionOrigin::Api, origin_from);
    tr.set_origin(origin);
    Ok(tr)
}

// --- Plugins as data ------------------------------------------------------------

/// Which plugin a [`RichPluginSpec`] makes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub(crate) enum RichPluginKind {
    /// Undo history (`depth`, `newGroupDelay`).
    #[default]
    History,
    /// Key bindings (`bindings`).
    Keymap,
    /// The base key bindings: Enter, Backspace, Delete, select all, ...
    /// (the platform's: `Mod` is Cmd on Apple platforms, Ctrl elsewhere).
    BaseKeymap,
    /// The starter schema's key bindings (marks, headings, lists, code).
    StarterKeymap,
    /// Input rules (`rules`).
    InputRules,
    /// Markdown shortcuts as you type, Markdown paste and copy.
    Markdown,
    /// The starter set: its input rules and key bindings, the base key
    /// bindings and the history.
    StarterKit,
    /// Tiptap's Link behavior: autolink, link on paste, open on click
    /// (`link`).
    Link,
    /// Tiptap's CharacterCount (`characterCount`).
    CharacterCount,
    /// Tiptap's Suggestion (`suggestion`).
    Suggestion,
}

/// A kernel plugin as data, made by `history()`, `keymap({...})`,
/// `inputRules([...])`, `markdown()`, `starterKit()`, ...
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct RichPluginSpec {
    /// Which plugin.
    pub(crate) plugin: RichPluginKind,
    /// `history`: how many changes it keeps (100 by default).
    #[prop(skip_none)]
    pub(crate) depth: Option<usize>,
    /// `history`: milliseconds within which changes group into one undo
    /// step (500 by default).
    #[prop(skip_none)]
    pub(crate) new_group_delay: Option<f64>,
    /// `keymap`: commands by key name (`"Mod-b"`, `"Shift-Enter"`).
    #[prop(skip_none)]
    pub(crate) bindings: Option<KeyBindings>,
    /// `inputRules`: the rules, in order.
    #[prop(skip_none)]
    pub(crate) rules: Option<Vec<RichInputRule>>,
    /// `markdown`: block shortcuts at a textblock's start (true by default).
    #[prop(skip_none)]
    pub(crate) block_rules: Option<bool>,
    /// `markdown`: inline marks completed by their closing delimiter (true
    /// by default).
    #[prop(skip_none)]
    pub(crate) inline_rules: Option<bool>,
    /// `markdown`: pasted text that looks like Markdown is read as
    /// Markdown (true by default).
    #[prop(skip_none)]
    pub(crate) paste: Option<bool>,
    /// `markdown`: copies put Markdown on the clipboard as their text (true
    /// by default).
    #[prop(skip_none)]
    pub(crate) copy_as_markdown: Option<bool>,
    /// `link`: its options.
    #[prop(skip_none)]
    pub(crate) link: Option<super::extensions::RichLinkOptions>,
    /// `characterCount`: its options.
    #[prop(skip_none)]
    pub(crate) character_count: Option<super::extensions::RichCharacterCountOptions>,
    /// `suggestion`: its options.
    #[prop(skip_none)]
    pub(crate) suggestion: Option<super::extensions::RichSuggestionOptions>,
}

/// Commands by key name, in the object's order. TS: `Record<string,
/// RichCommand>`.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct KeyBindings(pub(crate) Vec<(String, RichCommand)>);

impl JsValue for KeyBindings {
    fn ts_type(types: &mut TsTypes) -> String {
        format!(
            "Record<string, {}>",
            <RichCommand as JsValue>::ts_type(types)
        )
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.kind() != JsKind::Object {
            return Err(value.expected("an object of commands by key"));
        }
        let mut out = Vec::new();
        for key in value.keys()? {
            let field = value.field(&key)?;
            let command = <RichCommand as JsValue>::from_js(field.get())
                .map_err(|e| PropError(format!("`{key}`: {e}")))?;
            out.push((key, command));
        }
        Ok(Self(out))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object = JsOwned::new(host, host.new_object()?);
        for (key, command) in &self.0 {
            host.set_field(object.get().raw(), key, command.to_js(host)?.into_raw())?;
        }
        Ok(object)
    }
}

/// What an input rule does.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub(crate) enum RichInputRuleKind {
    /// Replaces the match with `replacement`.
    #[default]
    Text,
    /// Gives the text between delimiters the mark `name`.
    Mark,
    /// Wraps the textblock in a node of type `name` (`"> "`, `"- "`).
    Wrapping,
    /// Makes the textblock a node of type `name` (`"# "`, three backticks).
    Textblock,
    /// Typographic quotes.
    SmartQuotes,
    /// `...` to an ellipsis.
    Ellipsis,
    /// `--` to an em dash.
    EmDash,
    /// The starter schema's Markdown-like rules (headings, quotes, lists,
    /// code blocks, rules, the common marks).
    Starter,
}

/// An input rule as data, made by `textRule`, `markRule`, `wrappingRule`,
/// `textblockRule`, `markdownRules`, ...
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct RichInputRule {
    /// What it does.
    pub(crate) rule: RichInputRuleKind,
    /// The regular expression the text before the cursor must match, ending
    /// in `$` (Rust's `regex` syntax, which reads JavaScript's common
    /// patterns alike: classes, groups, `\s`, `^`, `$`).
    #[prop(skip_none, rename = "match")]
    pub(crate) pattern: Option<String>,
    /// `text`: what replaces the match.
    #[prop(skip_none)]
    pub(crate) replacement: Option<String>,
    /// `mark`, `wrapping`, `textblock`: the type's name.
    #[prop(skip_none)]
    pub(crate) name: Option<String>,
    /// The attributes of what it makes.
    #[prop(skip_none)]
    pub(crate) attrs: Option<AttrsJson>,
    /// Whether Backspace right after it undoes it (true by default).
    #[prop(skip_none)]
    pub(crate) undoable: Option<bool>,
}

/// One entry of an editor's `plugins`: a kernel plugin as data or the
/// app's `RichEditorPlugin`. TS: `RichPluginSpec | RichEditorPlugin`.
#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)] // a few per editor, made once
pub(crate) enum PluginEntry {
    Spec(RichPluginSpec),
    Js(Instance<RichEditorPlugin>),
}

impl PartialEq for PluginEntry {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Spec(a), Self::Spec(b)) => a == b,
            (Self::Js(a), Self::Js(b)) => a.ptr_eq(b),
            _ => false,
        }
    }
}

impl JsValue for PluginEntry {
    fn ts_type(types: &mut TsTypes) -> String {
        format!(
            "{} | {}",
            <RichPluginSpec as JsValue>::ts_type(types),
            <Instance<RichEditorPlugin> as Arg>::ts_type(types)
        )
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.host().instance(value.raw()).is_some() {
            return <Instance<RichEditorPlugin> as Arg>::from_js(value).map(Self::Js);
        }
        <RichPluginSpec as JsValue>::from_js(value).map(Self::Spec)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Spec(spec) => spec.to_js(host),
            Self::Js(plugin) => Ret::into_js(plugin.clone(), host),
        }
    }
}

fn regex_of(rule: &RichInputRule) -> Result<Regex, String> {
    let pattern = rule
        .pattern
        .as_deref()
        .ok_or_else(|| format!("a {:?} input rule needs a `match`", rule.rule))?;
    Regex::new(pattern).map_err(|e| format!("input rule `{pattern}`: {e}"))
}

fn const_attrs(attrs: Option<Attrs>) -> Option<crate::rich_editor::extensions::GetAttrs> {
    attrs.map(|attrs| -> crate::rich_editor::extensions::GetAttrs {
        Arc::new(move |_| Some(attrs.clone()))
    })
}

/// `rules` resolved against `schema`.
pub(crate) fn input_rule_list(
    rules: &[RichInputRule],
    schema: &Schema,
) -> Result<Vec<InputRule>, String> {
    let mut out = Vec::new();
    for rule in rules {
        let node = || {
            let name = rule.name.as_deref().ok_or("the rule needs a type `name`")?;
            schema
                .node_type(name)
                .ok_or_else(|| format!("the schema has no node type `{name}`"))
        };
        let mut made = match rule.rule {
            RichInputRuleKind::Text => vec![InputRule::text(
                regex_of(rule)?,
                rule.replacement.as_deref().unwrap_or_default(),
            )],
            RichInputRuleKind::Mark => {
                let name = rule.name.as_deref().ok_or("a mark rule needs a `name`")?;
                let ty = schema
                    .mark_type(name)
                    .ok_or_else(|| format!("the schema has no mark type `{name}`"))?;
                vec![mark_input_rule(
                    regex_of(rule)?,
                    ty,
                    const_attrs(attrs_of(&rule.attrs)?),
                )]
            }
            RichInputRuleKind::Wrapping => vec![wrapping_input_rule(
                regex_of(rule)?,
                node()?,
                const_attrs(attrs_of(&rule.attrs)?),
                None,
            )],
            RichInputRuleKind::Textblock => vec![textblock_type_input_rule(
                regex_of(rule)?,
                node()?,
                const_attrs(attrs_of(&rule.attrs)?),
            )],
            RichInputRuleKind::SmartQuotes => smart_quotes(),
            RichInputRuleKind::Ellipsis => vec![ellipsis()],
            RichInputRuleKind::EmDash => vec![em_dash()],
            RichInputRuleKind::Starter => starter::input_rule_list(schema),
        };
        if let Some(undoable) = rule.undoable {
            made = made.into_iter().map(|r| r.undoable(undoable)).collect();
        }
        out.extend(made);
    }
    Ok(out)
}

/// `bindings` resolved against `schema`.
pub(crate) fn bindings_of(
    bindings: &KeyBindings,
    schema: &Schema,
) -> Result<Vec<(String, BoxCommand)>, String> {
    bindings
        .0
        .iter()
        .map(|(key, command)| {
            resolve(command, schema)
                .map(|command| (key.clone(), command))
                .map_err(|e| format!("key `{key}`: {e}"))
        })
        .collect()
}

/// `spec`'s plugins for `schema`.
pub(crate) fn plugins_of(spec: &RichPluginSpec, schema: &Schema) -> Result<Vec<Plugin>, String> {
    Ok(match spec.plugin {
        RichPluginKind::History => {
            let mut options = HistoryOptions::default();
            if let Some(depth) = spec.depth {
                options.depth = depth;
            }
            if let Some(delay) = spec.new_group_delay.filter(|d| d.is_finite() && *d >= 0.0) {
                options.new_group_delay_ms = delay as u64;
            }
            vec![history(options)]
        }
        RichPluginKind::Keymap => {
            let bindings = bindings_of(
                spec.bindings.as_ref().unwrap_or(&KeyBindings::default()),
                schema,
            )?;
            vec![keymap_plugin(
                Keymap::new(bindings, &KeymapOptions::default()).map_err(|e| e.to_string())?,
            )]
        }
        RichPluginKind::BaseKeymap => vec![keymap_plugin(
            Keymap::new(base_keymap(), &KeymapOptions::default()).map_err(|e| e.to_string())?,
        )],
        RichPluginKind::StarterKeymap => vec![keymap_plugin(
            Keymap::new(starter::keymap(schema), &KeymapOptions::default())
                .map_err(|e| e.to_string())?,
        )],
        RichPluginKind::InputRules => vec![input_rules(input_rule_list(
            spec.rules.as_deref().unwrap_or_default(),
            schema,
        )?)],
        RichPluginKind::Markdown => markdown::markdown(MarkdownOptions {
            block_rules: spec.block_rules.unwrap_or(true),
            inline_rules: spec.inline_rules.unwrap_or(true),
            paste: spec.paste.unwrap_or(true),
            copy_as_markdown: spec.copy_as_markdown.unwrap_or(true),
            ..MarkdownOptions::default()
        }),
        RichPluginKind::StarterKit => starter::plugins(schema),
        RichPluginKind::Link => {
            super::extensions::link_plugins(spec.link.as_ref().unwrap_or(&Default::default()))
        }
        RichPluginKind::CharacterCount => vec![super::extensions::character_count_plugin(
            spec.character_count.as_ref().unwrap_or(&Default::default()),
        )?],
        RichPluginKind::Suggestion => vec![super::extensions::suggestion_plugin(
            spec.suggestion.as_ref().unwrap_or(&Default::default()),
        )],
    })
}

/// The plugins of `entries` for `schema`, in order.
pub(crate) fn resolve_plugins(
    entries: &[PluginEntry],
    schema: &Schema,
) -> Result<Vec<Plugin>, String> {
    let mut out = Vec::new();
    for entry in entries {
        match entry {
            PluginEntry::Spec(spec) => out.extend(plugins_of(spec, schema)?),
            PluginEntry::Js(plugin) => out.push(plugin.with(|p| p.plugin())),
        }
    }
    Ok(out)
}

// --- Plugins whose hooks are the app's ------------------------------------------

/// A decoration as data: what `editor.setDecorations` takes.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct RichDecoration {
    /// Where it starts.
    pub(crate) from: usize,
    /// Where it ends (`from` for a widget).
    #[prop(skip_none)]
    pub(crate) to: Option<usize>,
    /// What it draws.
    pub(crate) kind: RichDecorationKind,
    /// `inline` and `node`: the attributes it gives (`class`, `style`).
    #[prop(skip_none)]
    pub(crate) attrs: Option<AttrsJson>,
    /// `widget`: what the view makes the widget from.
    #[prop(skip_none)]
    pub(crate) widget: Option<String>,
    /// `widget`: negative to stay before content inserted at its position.
    #[prop(skip_none)]
    pub(crate) side: Option<i32>,
    /// `inline`: content inserted at its start joins it.
    #[prop(skip_none)]
    pub(crate) inclusive_start: Option<bool>,
    /// `inline`: content inserted at its end joins it.
    #[prop(skip_none)]
    pub(crate) inclusive_end: Option<bool>,
    /// The plugin's own data, what it finds decorations by.
    #[prop(skip_none)]
    pub(crate) spec: Option<AttrsJson>,
}

/// What a [`RichDecoration`] draws.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub(crate) enum RichDecorationKind {
    /// Attributes on the inline content of the range.
    #[default]
    Inline,
    /// A widget at `from`.
    Widget,
    /// Attributes on the node spanning the range.
    Node,
}

impl RichDecoration {
    pub(crate) fn to_kernel(&self) -> Result<Decoration, String> {
        let attrs = attrs_of(&self.attrs)?.unwrap_or_default();
        let to = self.to.unwrap_or(self.from);
        let decoration = match self.kind {
            RichDecorationKind::Inline => Decoration::inline(self.from, to, attrs).inclusive(
                self.inclusive_start.unwrap_or(false),
                self.inclusive_end.unwrap_or(false),
            ),
            RichDecorationKind::Widget => Decoration::widget(
                self.from,
                self.widget.as_deref().unwrap_or_default(),
                self.side.unwrap_or(0),
            ),
            RichDecorationKind::Node => Decoration::node(self.from, to, attrs),
        };
        Ok(match attrs_of(&self.spec)? {
            Some(spec) => decoration.with_spec(spec),
            None => decoration,
        })
    }
}

/// The kernel's side of a [`RichEditorPlugin`].
struct JsPlugin {
    key: PluginKey,
    hooks: Arc<HookRef>,
    capturing: Arc<AtomicBool>,
    keys: Arc<Mutex<Keymap>>,
}

impl PluginSpec for JsPlugin {
    fn key(&self) -> PluginKey {
        self.key.clone()
    }

    fn init_state(
        &self,
        _config: &crate::rich_editor::state::EditorStateConfig,
        _state: &EditorState,
    ) -> Option<PluginState> {
        Some(Arc::new(DecorationSet::empty()))
    }

    fn apply_state(
        &self,
        tr: &Transaction,
        value: &PluginState,
        _old: &EditorState,
        new: &EditorState,
    ) -> PluginState {
        if let Some(Value::Array(items)) = tr
            .get_plugin_meta(&self.key)
            .and_then(|meta| meta.get("decorations"))
        {
            let decorations = items.iter().filter_map(decoration_from_json).collect();
            return Arc::new(DecorationSet::create(new.doc(), decorations));
        }
        match value.clone().downcast::<DecorationSet>() {
            Ok(set) if tr.doc_changed() => Arc::new(set.map(&tr.mapping, new.doc())),
            Ok(set) => set,
            Err(_) => Arc::new(DecorationSet::empty()),
        }
    }

    fn decorations(&self, state: &EditorState) -> Option<DecorationSet> {
        self.key
            .get_state::<DecorationSet>(state)
            .filter(|set| !set.is_empty())
            .map(|set| (*set).clone())
    }

    fn filter_transaction(&self, tr: &Transaction, _state: &EditorState) -> bool {
        if !in_js_call() {
            return true;
        }
        let Some(filter) = self.hooks.get().and_then(|h| h.filter) else {
            return true;
        };
        filter
            .call(transaction_json(tr, None))
            .unwrap_or_else(|error| {
                log::warn!("{}: filterTransaction threw: {error}", self.key);
                true
            })
    }

    fn append_transaction(
        &self,
        trs: &[Transaction],
        _old: &EditorState,
        new: &EditorState,
    ) -> Option<Transaction> {
        if !in_js_call() {
            return None;
        }
        let append = self.hooks.get().and_then(|h| h.append)?;
        let trs = trs.iter().map(|tr| transaction_json(tr, None)).collect();
        match append.call((trs, StateJson(new.to_json()))) {
            Ok(Some(json)) => match transaction_from_json(new, &json.0) {
                Ok(mut tr) => {
                    tr.set_origin(TransactionOrigin::Plugin(self.key.name().to_owned()));
                    Some(tr)
                }
                Err(error) => {
                    log::warn!("{}: appendTransaction: {error}", self.key);
                    None
                }
            },
            Ok(None) => None,
            Err(error) => {
                log::warn!("{}: appendTransaction threw: {error}", self.key);
                None
            }
        }
    }

    fn handle_key_down(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        if !self.capturing.load(Ordering::Relaxed) {
            return false;
        }
        let keymap = match self.keys.lock() {
            Ok(keys) => keys.clone(),
            Err(_) => return false,
        };
        keymap.handle(state, event, dispatch)
    }
}

fn decoration_from_json(item: &Value) -> Option<Decoration> {
    let from = item.get("from")?.as_u64()? as usize;
    let to = item
        .get("to")
        .and_then(Value::as_u64)
        .map_or(from, |to| to as usize);
    let attrs = |key: &str| -> Attrs {
        item.get(key)
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    };
    let decoration = match item.get("kind").and_then(Value::as_str).unwrap_or("inline") {
        "widget" => Decoration::widget(
            from,
            item.get("widget")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            item.get("side").and_then(Value::as_i64).unwrap_or(0) as i32,
        ),
        "node" => Decoration::node(from, to, attrs("attrs")),
        _ => Decoration::inline(from, to, attrs("attrs")).inclusive(
            item.get("inclusiveStart")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            item.get("inclusiveEnd")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    };
    let spec = attrs("spec");
    Some(if spec.is_empty() {
        decoration
    } else {
        decoration.with_spec(spec)
    })
}

/// The JSON a transaction carries for a plugin's new decorations.
pub(crate) fn decorations_json(decorations: &[RichDecoration]) -> Result<Value, String> {
    let items = decorations
        .iter()
        .map(|d| {
            // Checked here, so a bad one throws in the app's call.
            d.to_kernel()?;
            let mut item = Map::new();
            item.insert("from".into(), json!(d.from));
            item.insert("to".into(), json!(d.to.unwrap_or(d.from)));
            item.insert(
                "kind".into(),
                json!(match d.kind {
                    RichDecorationKind::Inline => "inline",
                    RichDecorationKind::Widget => "widget",
                    RichDecorationKind::Node => "node",
                }),
            );
            for (key, value) in [("attrs", &d.attrs), ("spec", &d.spec)] {
                if let Some(value) = value {
                    item.insert(key.into(), value.0.clone());
                }
            }
            if let Some(widget) = &d.widget {
                item.insert("widget".into(), json!(widget));
            }
            if let Some(side) = d.side {
                item.insert("side".into(), json!(side));
            }
            if let Some(start) = d.inclusive_start {
                item.insert("inclusiveStart".into(), json!(start));
            }
            if let Some(end) = d.inclusive_end {
                item.insert("inclusiveEnd".into(), json!(end));
            }
            Ok(Value::Object(item))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({ "decorations": items }))
}

/// A plugin whose behavior is the app's: keys it captures while it says so
/// (a suggestion list's arrows and Enter), decorations it hands over
/// (`editor.setDecorations(key, ...)`), and `filterTransaction` /
/// `appendTransaction` for the transactions the app's own calls make.
/// Typing never waits for JS: captured keys are consumed natively and
/// reported after, and the transaction hooks are not asked about the
/// platform's input (an editor's `subscribe` hears every change).
#[class]
pub(crate) struct RichEditorPlugin {
    key: PluginKey,
    hooks: Arc<HookRef>,
    capturing: Arc<AtomicBool>,
    keys: Arc<Mutex<Keymap>>,
}

#[class]
impl RichEditorPlugin {
    /// A plugin with the unique key `key` (its decorations and metadata
    /// are found by it).
    pub(crate) fn new(key: String) -> Self {
        Self {
            key: PluginKey::new(&key),
            hooks: HookRef::new(),
            capturing: Arc::new(AtomicBool::new(false)),
            keys: Arc::new(Mutex::new(Keymap::default())),
        }
    }

    /// Its key.
    #[getter]
    pub(crate) fn key(&self) -> String {
        self.key.name().to_owned()
    }

    /// Asks `hook` whether a transaction the app's code makes may apply
    /// (`false` drops it).
    pub(crate) fn filter_transaction(
        this: Instance<Self>,
        #[args(tr)] hook: Callback<TransactionJson, bool>,
    ) -> Instance<Self> {
        this.with(|p| p.hooks.update(|h| h.filter = Some(hook)));
        this
    }

    /// Asks `hook` for a transaction to apply after the ones the app's
    /// code made (`null` for none); its steps are against `state`'s
    /// document.
    pub(crate) fn append_transaction(
        this: Instance<Self>,
        #[args(trs, state)] hook: Callback<
            (Vec<TransactionJson>, StateJson),
            Option<TransactionJson>,
        >,
    ) -> Instance<Self> {
        this.with(|p| p.hooks.update(|h| h.append = Some(hook)));
        this
    }

    /// Consumes `keys` (`"ArrowUp"`, `"Enter"`, `"Mod-k"`) while the plugin
    /// is capturing and tells `handler` which one was pressed, after.
    pub(crate) fn capture_keys(
        this: Instance<Self>,
        keys: Vec<String>,
        #[args(key)] handler: Callback<String>,
    ) -> Result<Instance<Self>, String> {
        let hooks = this.with(|p| p.hooks.clone());
        let bindings = keys
            .into_iter()
            .map(|key| {
                let hooks = hooks.clone();
                let name = key.clone();
                let command: BoxCommand = command(move |_, dispatch| {
                    // Only the real press reports, not a dry run.
                    if dispatch.is_some()
                        && let Some(keys) = hooks.get().and_then(|h| h.keys)
                    {
                        keys.post(name.clone());
                    }
                    true
                });
                (key, command)
            })
            .collect();
        let keymap = Keymap::new(bindings, &KeymapOptions::default()).map_err(|e| e.to_string())?;
        this.with(|p| {
            if let Ok(mut keys) = p.keys.lock() {
                *keys = keymap;
            }
            p.hooks.update(|h| h.keys = Some(handler));
        });
        Ok(this)
    }

    /// Whether the captured keys are consumed now (a suggestion list is
    /// open).
    #[getter]
    pub(crate) fn capturing(&self) -> bool {
        self.capturing.load(Ordering::Relaxed)
    }

    /// Starts or stops consuming the captured keys.
    #[setter]
    pub(crate) fn set_capturing(&mut self, capturing: bool) {
        self.capturing.store(capturing, Ordering::Relaxed);
    }
}

impl RichEditorPlugin {
    /// The kernel's plugin.
    pub(crate) fn plugin(&self) -> Plugin {
        Arc::new(JsPlugin {
            key: self.key.clone(),
            hooks: self.hooks.clone(),
            capturing: self.capturing.clone(),
            keys: self.keys.clone(),
        })
    }
}
