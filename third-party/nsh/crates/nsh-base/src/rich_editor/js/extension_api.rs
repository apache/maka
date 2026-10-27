//! Extensions in TS: the built-in ones as classes whose statics make them
//! (`StarterKit.configure({ heading: { levels: [1, 2] } })`,
//! `Bold.extend({...})`; the class itself is the extension with its
//! defaults: `extensions: [StarterKit, Underline]`), `RichExtension`
//! (what they make, with `configure` and `extend`), `defineExtension({...})`
//! for the app's own and `richExtension(name)` for those an app's crate
//! registered.
//!
//! An extension's functions (`addKeyboardShortcuts`, `addCommands`,
//! `addInputRules`, ...) run once, in `createRichEditor`, with the
//! extension's options: what they return is data (commands as
//! `toggleMark("bold")`, rules as `markRule(...)`, plugins as `history()` or
//! a `RichEditorPlugin`), resolved in Rust. Typing and keys never call JS.

use std::sync::{Arc, Mutex};

use nsh_core::{
    JsonValue,
    element::{Arg, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, Ret, TsTypes},
    prelude::*,
};
use regex::Regex;

use super::{
    commands::{RichCommand, attrs_of, resolve_with},
    plugins::{
        KeyBindings, PluginEntry, RichInputRule, RichInputRuleKind, input_rule_list, plugins_of,
    },
};
use crate::rich_editor::{
    commands::{BoxCommand, CommandFactory, CommandRegistry},
    extensions::{
        Extension, ExtensionKind, GetAttrs, GlobalAttributes, extension_named, merge_options,
        paste_rules::{PasteRule, mark_paste_rule, text_paste_rule},
    },
    model::{AttrSpec, SchemaSpec},
    state::Plugin,
};

/// Errors the extensions' parts found while the editor was made: thrown by
/// `createRichEditor`.
pub(crate) type Diagnostics = Arc<Mutex<Vec<String>>>;

fn report(diagnostics: &Diagnostics, error: String) {
    if let Ok(mut list) = diagnostics.lock() {
        list.push(error);
    }
}

// --- What `defineExtension` and `extend` take ------------------------------------

/// An extension's definition (Tiptap's `Extension.create` / `Node.create`
/// / `Mark.create` config), or what `extend` replaces. TS:
/// `RichExtensionConfig`.
#[derive(Clone, Default)]
pub(crate) struct RichExtensionConfig {
    name: Option<String>,
    priority: Option<i32>,
    node: Option<JsonValue>,
    mark: Option<JsonValue>,
    top_node: Option<bool>,
    hooks: JsHooks,
}

/// The app's functions of one extension.
#[derive(Clone, Default)]
pub(crate) struct JsHooks {
    add_options: Option<Callback<(), JsonValue>>,
    add_keyboard_shortcuts: Option<Callback<JsonValue, KeyBindings>>,
    add_commands: Option<Callback<JsonValue, KeyBindings>>,
    add_input_rules: Option<Callback<JsonValue, Vec<RichInputRule>>>,
    add_paste_rules: Option<Callback<JsonValue, Vec<RichInputRule>>>,
    add_prose_mirror_plugins: Option<Callback<JsonValue, Vec<PluginEntry>>>,
    add_global_attributes: Option<Callback<JsonValue, JsonValue>>,
    add_storage: Option<Callback<JsonValue, JsonValue>>,
}

impl JsHooks {
    // `other`'s functions over these.
    fn overridden_by(&self, other: &JsHooks) -> JsHooks {
        JsHooks {
            add_options: other.add_options.clone().or(self.add_options.clone()),
            add_keyboard_shortcuts: other
                .add_keyboard_shortcuts
                .clone()
                .or(self.add_keyboard_shortcuts.clone()),
            add_commands: other.add_commands.clone().or(self.add_commands.clone()),
            add_input_rules: other
                .add_input_rules
                .clone()
                .or(self.add_input_rules.clone()),
            add_paste_rules: other
                .add_paste_rules
                .clone()
                .or(self.add_paste_rules.clone()),
            add_prose_mirror_plugins: other
                .add_prose_mirror_plugins
                .clone()
                .or(self.add_prose_mirror_plugins.clone()),
            add_global_attributes: other
                .add_global_attributes
                .clone()
                .or(self.add_global_attributes.clone()),
            add_storage: other.add_storage.clone().or(self.add_storage.clone()),
        }
    }
}

const CONFIG_TS: &str = "/** An extension's definition (`defineExtension`), or the parts `extend` replaces. Each function runs once, when an editor is made, with the extension's options; what it returns is data the editor resolves natively. */
export interface RichExtensionConfig {
  /** Its name (a node's or mark's is its type's). */
  name?: string;
  /** Its rank: higher comes first in the schema, keymaps and rules (100). */
  priority?: number;
  /** The node type it adds, in `defineSchema`'s form (`content`, `group`, `attrs`, `parseDOM`, ...). */
  node?: Record<string, unknown>;
  /** The mark type it adds, in `defineSchema`'s form. */
  mark?: Record<string, unknown>;
  /** Whether its node is the document's. */
  topNode?: boolean;
  /** Its default options; `configure` merges over them. */
  addOptions?: () => Record<string, unknown>;
  /** Commands by key name (`\"Mod-k\"`). */
  addKeyboardShortcuts?: (options: any) => Record<string, {command}>;
  /** Named commands, each a command as data (run with `command(name)`). */
  addCommands?: (options: any) => Record<string, {command}>;
  /** Input rules (`markRule`, `textRule`, `wrappingRule`, `textblockRule`). */
  addInputRules?: (options: any) => {rule}[];
  /** Paste rules: `textRule` and `markRule` applied to pasted text. */
  addPasteRules?: (options: any) => {rule}[];
  /** Plugins: kernel plugins as data or `RichEditorPlugin`s. */
  addProseMirrorPlugins?: (options: any) => {plugin}[];
  /** Attributes on other types: `[{ types: [\"paragraph\"], attributes: { name: { default: null } } }]`. */
  addGlobalAttributes?: (options: any) => { types: string[]; attributes: Record<string, unknown> }[];
  /** Its storage's first value. */
  addStorage?: (options: any) => unknown;
}";

impl Arg for RichExtensionConfig {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("RichExtensionConfig", |types| {
            CONFIG_TS
                .replace("{command}", &<RichCommand as JsValue>::ts_type(types))
                .replace("{rule}", &<RichInputRule as JsValue>::ts_type(types))
                .replace("{plugin}", &<PluginEntry as JsValue>::ts_type(types))
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.kind() != JsKind::Object {
            return Err(value.expected("an extension's definition"));
        }
        fn field<T: Arg>(value: &JsIn<'_>, key: &str) -> Result<T, PropError> {
            let field = value.field(key)?;
            T::from_js(field.get()).map_err(|e| PropError(format!("`{key}`: {e}")))
        }
        let priority: Option<f64> = field(&value, "priority")?;
        Ok(Self {
            name: field(&value, "name")?,
            priority: priority.map(|p| p as i32),
            node: field(&value, "node")?,
            mark: field(&value, "mark")?,
            top_node: field(&value, "topNode")?,
            hooks: JsHooks {
                add_options: field(&value, "addOptions")?,
                add_keyboard_shortcuts: field(&value, "addKeyboardShortcuts")?,
                add_commands: field(&value, "addCommands")?,
                add_input_rules: field(&value, "addInputRules")?,
                add_paste_rules: field(&value, "addPasteRules")?,
                add_prose_mirror_plugins: field(&value, "addProseMirrorPlugins")?,
                add_global_attributes: field(&value, "addGlobalAttributes")?,
                add_storage: field(&value, "addStorage")?,
            },
        })
    }

    fn classes(out: &mut Vec<&'static nsh_core::element::ClassDef>) {
        <PluginEntry as Arg>::classes(out);
    }
}

// --- RichExtension -----------------------------------------------------------------

/// An editor extension (Tiptap's): a built-in one (`StarterKit`, `Bold`,
/// ...), one an app's crate registered (`richExtension(name)`) or the
/// app's (`defineExtension`), with its options. `createRichEditor({
/// extensions: [...] })` makes the editor's schema, keymaps, rules,
/// plugins and commands from them.
#[class]
pub(crate) struct RichExtension {
    /// The Rust extension it starts from (none for `defineExtension`'s).
    base: Option<Extension>,
    /// What `configure` merged, over the defaults.
    configured: JsonValue,
    /// Its definition's data (its functions are the fields below, which
    /// the class traces).
    def: RichExtensionConfig,
    add_options: Option<Callback<(), JsonValue>>,
    add_keyboard_shortcuts: Option<Callback<JsonValue, KeyBindings>>,
    add_commands: Option<Callback<JsonValue, KeyBindings>>,
    add_input_rules: Option<Callback<JsonValue, Vec<RichInputRule>>>,
    add_paste_rules: Option<Callback<JsonValue, Vec<RichInputRule>>>,
    add_prose_mirror_plugins: Option<Callback<JsonValue, Vec<PluginEntry>>>,
    add_global_attributes: Option<Callback<JsonValue, JsonValue>>,
    add_storage: Option<Callback<JsonValue, JsonValue>>,
}

impl RichExtension {
    fn of(base: Extension) -> Self {
        Self::make(Some(base), JsonValue::Null, RichExtensionConfig::default())
    }

    // An extension of `def`, its functions taken out of it.
    fn make(base: Option<Extension>, configured: JsonValue, mut def: RichExtensionConfig) -> Self {
        let hooks = std::mem::take(&mut def.hooks);
        Self {
            base,
            configured,
            def,
            add_options: hooks.add_options,
            add_keyboard_shortcuts: hooks.add_keyboard_shortcuts,
            add_commands: hooks.add_commands,
            add_input_rules: hooks.add_input_rules,
            add_paste_rules: hooks.add_paste_rules,
            add_prose_mirror_plugins: hooks.add_prose_mirror_plugins,
            add_global_attributes: hooks.add_global_attributes,
            add_storage: hooks.add_storage,
        }
    }

    // Its definition with its functions.
    fn config(&self) -> RichExtensionConfig {
        RichExtensionConfig {
            hooks: JsHooks {
                add_options: self.add_options.clone(),
                add_keyboard_shortcuts: self.add_keyboard_shortcuts.clone(),
                add_commands: self.add_commands.clone(),
                add_input_rules: self.add_input_rules.clone(),
                add_paste_rules: self.add_paste_rules.clone(),
                add_prose_mirror_plugins: self.add_prose_mirror_plugins.clone(),
                add_global_attributes: self.add_global_attributes.clone(),
                add_storage: self.add_storage.clone(),
            },
            ..self.def.clone()
        }
    }

    fn name_of(&self) -> String {
        self.def
            .name
            .clone()
            .or_else(|| self.base.as_ref().map(|b| b.name.clone()))
            .unwrap_or_default()
    }

    /// Its options: the Rust extension's, then `addOptions`', then what
    /// `configure` merged. Calls `addOptions` (in a call from JS).
    fn resolved_options(&self) -> Result<JsonValue, String> {
        let mut options = self.base.as_ref().map_or_else(
            || JsonValue::Object(Default::default()),
            |b| b.options.clone(),
        );
        if let Some(add) = &self.add_options {
            let defaults = add
                .call(())
                .map_err(|e| format!("{}: addOptions threw: {e}", self.name_of()))?;
            options = merge_options(&options, &defaults);
        }
        Ok(merge_options(&options, &self.configured))
    }

    /// The Rust extension it makes: the app's functions called now with
    /// its options, their results resolved when the editor's schema is
    /// made (errors into `diagnostics`).
    pub(crate) fn to_extension(&self, diagnostics: &Diagnostics) -> Result<Extension, String> {
        let name = self.name_of();
        if name.is_empty() {
            return Err("an extension needs a `name`".into());
        }
        let options = self.resolved_options()?;
        let config = self.config();
        let mut ext = match &self.base {
            Some(base) => base.clone().named(name.clone()),
            None => Extension::new(name.clone()),
        };
        if let Some(spec) = &config.node {
            let node = parse_spec("nodes", &name, spec)?.nodes.remove(0).1;
            ext = ext.with_node_spec(move |_| node.clone());
        } else if let Some(spec) = &config.mark {
            let mark = parse_spec("marks", &name, spec)?.marks.remove(0).1;
            ext = ext.with_mark_spec(move |_| mark.clone());
        }
        ext.options = options.clone();
        if let Some(priority) = config.priority {
            ext.priority = priority;
        }
        if config.top_node == Some(true) {
            ext = ext.with_top_node();
        }
        let call_error = |hook: &str, e: String| format!("{name}: {hook} threw: {e}");
        let hooks = &config.hooks;
        if let Some(hook) = &hooks.add_keyboard_shortcuts {
            let bindings = hook
                .call(options.clone())
                .map_err(|e| call_error("addKeyboardShortcuts", e))?;
            let diagnostics = diagnostics.clone();
            ext = ext.add_keyboard_shortcuts(move |cx| {
                resolved(&bindings, cx.schema, cx.commands, &diagnostics, cx.name)
            });
        }
        if let Some(hook) = &hooks.add_commands {
            let commands = hook
                .call(options.clone())
                .map_err(|e| call_error("addCommands", e))?;
            ext = ext.add_commands(move |_| {
                commands
                    .0
                    .iter()
                    .map(|(name, command)| {
                        let command = command.clone();
                        let factory: CommandFactory = Arc::new(move |_, schema| {
                            resolve_with(&command, schema, &CommandRegistry::builtin())
                        });
                        (name.clone(), factory)
                    })
                    .collect()
            });
        }
        if let Some(hook) = &hooks.add_input_rules {
            let rules = hook
                .call(options.clone())
                .map_err(|e| call_error("addInputRules", e))?;
            let diagnostics = diagnostics.clone();
            ext = ext.add_input_rules(move |cx| {
                input_rule_list(&rules, cx.schema).unwrap_or_else(|e| {
                    report(&diagnostics, format!("{}: {e}", cx.name));
                    Vec::new()
                })
            });
        }
        if let Some(hook) = &hooks.add_paste_rules {
            let rules = hook
                .call(options.clone())
                .map_err(|e| call_error("addPasteRules", e))?;
            let diagnostics = diagnostics.clone();
            ext = ext.add_paste_rules(move |cx| {
                paste_rule_list(&rules, cx.schema).unwrap_or_else(|e| {
                    report(&diagnostics, format!("{}: {e}", cx.name));
                    Vec::new()
                })
            });
        }
        if let Some(hook) = &hooks.add_prose_mirror_plugins {
            let entries = hook
                .call(options.clone())
                .map_err(|e| call_error("addProseMirrorPlugins", e))?;
            // The app's plugins are made now (their functions stay on this
            // thread); plugins as data when the schema is known.
            let mut made: Vec<Plugin> = Vec::new();
            let mut specs = Vec::new();
            for entry in entries {
                match entry {
                    PluginEntry::Js(plugin) => made.push(plugin.with(|p| p.plugin())),
                    PluginEntry::Spec(spec) => specs.push(spec),
                }
            }
            let diagnostics = diagnostics.clone();
            ext = ext.add_plugins(move |cx| {
                let mut plugins = Vec::new();
                for spec in &specs {
                    match plugins_of(spec, cx.schema) {
                        Ok(more) => plugins.extend(more),
                        Err(e) => report(&diagnostics, format!("{}: {e}", cx.name)),
                    }
                }
                plugins.extend(made.iter().cloned());
                plugins
            });
        }
        if let Some(hook) = &hooks.add_global_attributes {
            let json = hook
                .call(options.clone())
                .map_err(|e| call_error("addGlobalAttributes", e))?;
            let globals = global_attributes(&json).map_err(|e| format!("{name}: {e}"))?;
            ext = ext.add_global_attributes(move |_| globals.clone());
        }
        if let Some(hook) = &hooks.add_storage {
            let value = hook
                .call(options.clone())
                .map_err(|e| call_error("addStorage", e))?;
            ext = ext.add_storage(move |_| value.clone());
        }
        Ok(ext)
    }
}

fn parse_spec(kind: &str, name: &str, spec: &JsonValue) -> Result<SchemaSpec, String> {
    let json = serde_json::json!({ kind: [[name, spec]] });
    SchemaSpec::parse_json(&json).map_err(|e| format!("{name}: {e}"))
}

// `addGlobalAttributes`' result read.
fn global_attributes(json: &JsonValue) -> Result<Vec<GlobalAttributes>, String> {
    let items = json
        .as_array()
        .ok_or("addGlobalAttributes returns an array")?;
    items
        .iter()
        .map(|item| {
            let types = item
                .get("types")
                .and_then(JsonValue::as_array)
                .ok_or("a global attribute needs `types`")?
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_owned)
                .collect();
            let attrs = item.get("attributes").cloned().unwrap_or(JsonValue::Null);
            let spec = parse_spec("nodes", "_", &serde_json::json!({ "attrs": attrs }))?;
            let attributes: Vec<(String, AttrSpec)> = spec
                .nodes
                .into_iter()
                .next()
                .map(|(_, node)| node.attrs)
                .unwrap_or_default();
            Ok(GlobalAttributes::new(types, attributes))
        })
        .collect()
}

fn resolved(
    bindings: &KeyBindings,
    schema: &crate::rich_editor::model::Schema,
    commands: &CommandRegistry,
    diagnostics: &Diagnostics,
    name: &str,
) -> Vec<(String, BoxCommand)> {
    bindings
        .0
        .iter()
        .filter_map(
            |(key, command)| match resolve_with(command, schema, commands) {
                Ok(command) => Some((key.clone(), command)),
                Err(e) => {
                    report(diagnostics, format!("{name}: key `{key}`: {e}"));
                    None
                }
            },
        )
        .collect()
}

fn paste_rule_list(
    rules: &[RichInputRule],
    schema: &crate::rich_editor::model::Schema,
) -> Result<Vec<PasteRule>, String> {
    rules
        .iter()
        .map(|rule| {
            let pattern = rule
                .pattern
                .as_deref()
                .ok_or("a paste rule needs a `match`")?;
            // A paste rule finds matches anywhere in the text: no anchor at
            // the end, as an input rule has.
            let pattern = pattern.strip_suffix('$').unwrap_or(pattern);
            let regex = Regex::new(pattern).map_err(|e| format!("paste rule `{pattern}`: {e}"))?;
            match rule.rule {
                RichInputRuleKind::Text => Ok(text_paste_rule(
                    regex,
                    rule.replacement.as_deref().unwrap_or_default(),
                )),
                RichInputRuleKind::Mark => {
                    let name = rule.name.as_deref().ok_or("a mark rule needs a `name`")?;
                    let ty = schema
                        .mark_type(name)
                        .ok_or_else(|| format!("the schema has no mark type `{name}`"))?;
                    let get_attrs = attrs_of(&rule.attrs)?
                        .map(|attrs| -> GetAttrs { Arc::new(move |_| Some(attrs.clone())) });
                    Ok(mark_paste_rule(regex, ty, get_attrs))
                }
                other => Err(format!(
                    "a paste rule is a text or mark rule, not {other:?}"
                )),
            }
        })
        .collect()
}

#[class]
impl RichExtension {
    /// Its name.
    #[getter]
    pub(crate) fn name(&self) -> String {
        self.name_of()
    }

    /// Its priority (100 by default; higher comes first).
    #[getter]
    pub(crate) fn priority(&self) -> f64 {
        f64::from(
            self.def
                .priority
                .or_else(|| self.base.as_ref().map(|b| b.priority))
                .unwrap_or(crate::rich_editor::extensions::DEFAULT_PRIORITY),
        )
    }

    /// What it adds to the schema: `"extension"`, `"node"` or `"mark"`.
    #[getter]
    pub(crate) fn r#type(&self) -> String {
        let kind = if self.def.node.is_some() {
            ExtensionKind::Node
        } else if self.def.mark.is_some() {
            ExtensionKind::Mark
        } else {
            self.base.as_ref().map(|b| b.kind).unwrap_or_default()
        };
        match kind {
            ExtensionKind::Node => "node",
            ExtensionKind::Mark => "mark",
            _ => "extension",
        }
        .into()
    }

    /// Its options: the defaults with what `configure` merged.
    #[getter]
    pub(crate) fn options(&self) -> Result<JsonValue, String> {
        self.resolved_options()
    }

    /// A copy with `options` merged deeply into its options (Tiptap's
    /// `configure`; `StarterKit.configure({ bold: false })` leaves bold
    /// out).
    pub(crate) fn configure(&self, options: Option<JsonValue>) -> RichExtension {
        RichExtension::make(
            self.base.clone(),
            merge_options(&self.configured, &options.unwrap_or(JsonValue::Null)),
            self.config(),
        )
    }

    /// A new extension from this one, with the parts `config` gives
    /// replaced (Tiptap's `extend`).
    pub(crate) fn extend(&self, config: RichExtensionConfig) -> RichExtension {
        let own = self.config();
        RichExtension::make(
            self.base.clone(),
            self.configured.clone(),
            RichExtensionConfig {
                name: config.name.or(own.name),
                priority: config.priority.or(own.priority),
                node: config.node.or(own.node),
                mark: config.mark.or(own.mark),
                top_node: config.top_node.or(own.top_node),
                hooks: own.hooks.overridden_by(&config.hooks),
            },
        )
    }
}

// --- The entries of `extensions` ---------------------------------------------------

/// One entry of an editor's `extensions`: a `RichExtension`, or a built-in
/// extension's class (`StarterKit`), which is that extension with its
/// defaults. TS: `RichExtension | RichExtensionClass`.
#[derive(Debug, Clone)]
pub(crate) enum ExtensionEntry {
    Extension(Instance<RichExtension>),
    Class(String),
}

impl PartialEq for ExtensionEntry {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Extension(a), Self::Extension(b)) => a.ptr_eq(b),
            (Self::Class(a), Self::Class(b)) => a == b,
            _ => false,
        }
    }
}

const CLASS_TS: &str = "/** A built-in extension's class (`StarterKit`, `Bold`, ...): in `extensions` it is the extension with its defaults. */
export interface RichExtensionClass {
  /** The extension with `options` merged into its defaults. */
  configure(options?: Record<string, unknown> | null): RichExtension;
  /** A new extension from it, with the parts `config` gives replaced. */
  extend(config: RichExtensionConfig): RichExtension;
}";

impl JsValue for ExtensionEntry {
    fn ts_type(types: &mut TsTypes) -> String {
        let extension = <Instance<RichExtension> as Arg>::ts_type(types);
        <RichExtensionConfig as Arg>::ts_type(types);
        let class = types.declare("RichExtensionClass", |_| CLASS_TS.into());
        format!("{extension} | {class}")
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.kind() == JsKind::Function {
            let name = value
                .field("name")?
                .get()
                .as_string()
                .ok_or_else(|| value.expected("an extension's class"))?;
            return extension_of_class(&name)
                .map(|_| Self::Class(name.clone()))
                .ok_or_else(|| PropError(format!("`{name}` is not an extension's class")));
        }
        <Instance<RichExtension> as Arg>::from_js(value).map(Self::Extension)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Extension(extension) => Ret::into_js(extension.clone(), host),
            Self::Class(name) => {
                let extension = extension_of_class(name)
                    .ok_or_else(|| PropError(format!("`{name}` is not an extension's class")))?;
                Ret::into_js(RichExtension::of(extension), host)
            }
        }
    }
}

/// The Rust extensions of `entries`, in order (the app's functions called
/// now); errors found later, when the schema is made, go to
/// `diagnostics`.
pub(crate) fn extensions_of(
    entries: &[ExtensionEntry],
    diagnostics: &Diagnostics,
) -> Result<Vec<Extension>, String> {
    entries
        .iter()
        .map(|entry| match entry {
            ExtensionEntry::Extension(extension) => extension.with(|e| e.to_extension(diagnostics)),
            ExtensionEntry::Class(name) => {
                extension_of_class(name).ok_or_else(|| format!("no extension `{name}`"))
            }
        })
        .collect()
}

/// The diagnostics' errors, as one message (none: `Ok`).
pub(crate) fn check(diagnostics: &Diagnostics) -> Result<(), String> {
    let list = diagnostics.lock().map(|l| l.clone()).unwrap_or_default();
    if list.is_empty() {
        Ok(())
    } else {
        Err(list.join("; "))
    }
}

/// `defineExtension`: the app's extension from its definition.
pub(crate) fn define(config: RichExtensionConfig) -> Result<RichExtension, String> {
    if config.name.as_deref().is_none_or(str::is_empty) {
        return Err("defineExtension needs a `name`".into());
    }
    if config.node.is_some() && config.mark.is_some() {
        return Err("an extension adds a node or a mark, not both".into());
    }
    Ok(RichExtension::make(None, JsonValue::Null, config))
}

/// `richExtension`: the extension `name` an app's crate registered, or a
/// built-in one, with `options`.
pub(crate) fn named(name: &str, options: Option<JsonValue>) -> Result<RichExtension, String> {
    let base = extension_named(name).ok_or_else(|| format!("no extension is named `{name}`"))?;
    Ok(RichExtension::of(base).configure(options))
}

// --- The built-in extensions' classes -------------------------------------------------

macro_rules! extension_classes {
    ($($class:ident => $name:literal, $doc:literal;)*) => {
        /// The built-in extension a class named `class` stands for.
        pub(crate) fn extension_of_class(class: &str) -> Option<Extension> {
            match class {
                $(stringify!($class) => extension_named($name),)*
                _ => None,
            }
        }

        /// Registers the built-in extensions' classes.
        pub(crate) fn register(registry: &mut nsh_core::element::Registry) {
            registry.class::<RichExtension>().module::<RichExtensionApi>();
            $(registry.class::<$class>();)*
        }

        $(
            #[doc = $doc]
            #[class]
            pub(crate) struct $class;

            #[class]
            impl $class {
                /// The extension with `options` merged into its defaults
                /// (Tiptap's `configure`).
                pub(crate) fn configure(options: Option<JsonValue>) -> Result<RichExtension, String> {
                    named($name, options)
                }

                /// A new extension from it, with the parts `config` gives
                /// replaced (Tiptap's `extend`).
                pub(crate) fn extend(config: RichExtensionConfig) -> Result<RichExtension, String> {
                    Ok(named($name, None)?.extend(config))
                }
            }
        )*
    };
}

extension_classes! {
    StarterKit => "starterKit", "Tiptap's StarterKit: the document, paragraphs, text, headings, quotes, lists and task lists, code blocks, hard breaks, rules, images, the common marks, text styles and alignment, history, typography, the trailing node and the list keymap. `StarterKit.configure({ heading: { levels: [1, 2] }, bold: false })` configures one or leaves it out.";
    Document => "doc", "The document node (`doc`), the editor's top node.";
    Paragraph => "paragraph", "Paragraphs (`paragraph`): `Mod-Alt-0`; `setParagraph`.";
    Heading => "heading", "Headings (`heading`) of the levels its `levels` option names: `Mod-Alt-1`..`6`, `# ` rules; `setHeading`, `toggleHeading`.";
    Blockquote => "blockquote", "Quotes (`blockquote`): `Mod-Shift-b`, `> `; `setBlockquote`, `toggleBlockquote`, `unsetBlockquote`.";
    BulletList => "bulletList", "Bullet lists (`bulletList`): `Mod-Shift-8`, `- `; `toggleBulletList`.";
    OrderedList => "orderedList", "Ordered lists (`orderedList`): `Mod-Shift-7`, `1. `; `toggleOrderedList`.";
    ListItem => "listItem", "List items (`listItem`): `Enter`, `Tab`, `Shift-Tab`.";
    TaskList => "taskList", "Task lists (`taskList`): `Mod-Shift-9`; `toggleTaskList`.";
    TaskItem => "taskItem", "Tasks (`taskItem`), checked or not: `[ ] ` / `[x] `; the option `nested` allows `Tab`.";
    CodeBlock => "codeBlock", "Code blocks (`codeBlock`): fences, `Mod-Alt-c`, leaving on a third Enter; `setCodeBlock`, `toggleCodeBlock`.";
    HardBreak => "hardBreak", "Line breaks (`hardBreak`): `Mod-Enter`, `Shift-Enter`; `setHardBreak`.";
    HorizontalRule => "horizontalRule", "Horizontal rules (`horizontalRule`): `---`; `setHorizontalRule`.";
    RichImage => "image", "Images (`image`, Tiptap's `Image`): `![alt](src)`; `setImage`.";
    Bold => "bold", "Bold (`bold`): `Mod-b`, `**text**`; `setBold`, `toggleBold`, `unsetBold`.";
    Italic => "italic", "Italic (`italic`): `Mod-i`, `*text*`; `setItalic`, `toggleItalic`, `unsetItalic`.";
    Strike => "strike", "Strikethrough (`strike`): `Mod-Shift-s`, `~~text~~`; `setStrike`, `toggleStrike`, `unsetStrike`.";
    Code => "code", "Inline code (`code`): `Mod-e`, `` `text` ``; `setCode`, `toggleCode`, `unsetCode`.";
    Underline => "underline", "Underline (`underline`): `Mod-u`; `setUnderline`, `toggleUnderline`, `unsetUnderline`.";
    Link => "link", "Links (`link`, `href` and `title`); its commands are `setLink`, `toggleLink`, `unsetLink`.";
    Highlight => "highlight", "Highlights (`highlight`, with a `color`): `Mod-Shift-h`, `==text==`; `setHighlight`, `toggleHighlight`, `unsetHighlight`.";
    Subscript => "subscript", "Subscript (`subscript`): `Mod-,`; `setSubscript`, `toggleSubscript`, `unsetSubscript`.";
    Superscript => "superscript", "Superscript (`superscript`): `Mod-.`; `setSuperscript`, `toggleSuperscript`, `unsetSuperscript`.";
    RichTextStyle => "textStyle", "Text styles (`textStyle`, Tiptap's `TextStyle`: `color`, `fontFamily`, `fontSize`, `backgroundColor`); `setTextStyle`, `unsetTextStyle`.";
    TextAlign => "textAlign", "Text alignment (`textAlign`) of the types its `types` option names: `Mod-Shift-l` / `e` / `r` / `j`; `setTextAlign`, `unsetTextAlign`.";
    History => "history", "Undo history (`history`, Tiptap 3's `undoRedo`; options `depth`, `newGroupDelay`): `Mod-z`, `Shift-Mod-z`, `Mod-y`.";
    TrailingNode => "trailingNode", "Keeps a node (the option `node`, the default block by default) at the document's end.";
    Typography => "typography", "Typographic replacements as you type (`--` to an em dash, quotes, arrows, ...), each turned off with `false` or replaced with a string.";
    ListKeymap => "listKeymap", "Tiptap's list keymap: Backspace and Delete at list items' edges join and lift them.";
}

// --- The functions -------------------------------------------------------------------

/// The rich text editor's extension functions.
#[module]
pub(crate) struct RichExtensionApi;

#[module(flat)]
impl RichExtensionApi {
    /// The app's extension (Tiptap's `Extension.create`, or `Node.create` /
    /// `Mark.create` with `node` / `mark`): its functions run once, when an
    /// editor is made with it, and return data.
    pub(crate) fn define_extension(config: RichExtensionConfig) -> Result<RichExtension, String> {
        define(config)
    }

    /// The extension `name` (one an app's crate registered, or a built-in
    /// one: `"text"`, `"bold"`, ...) with `options` merged into its
    /// defaults.
    pub(crate) fn rich_extension(
        name: String,
        options: Option<JsonValue>,
    ) -> Result<RichExtension, String> {
        named(&name, options)
    }
}
