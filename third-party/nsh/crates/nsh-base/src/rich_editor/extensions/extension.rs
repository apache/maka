//! Extensions, Tiptap's unit of editor behavior: one [`Extension`]
//! contributes, together, to the schema (a node or mark type, attributes
//! on other types) and to the editor made with it (keyboard shortcuts,
//! input and paste rules, plugins, named commands, storage), with Tiptap's
//! names and semantics. [`ExtensionManager`] resolves a list of them as
//! Tiptap's `ExtensionManager` does: children flattened after their
//! parent (`addExtensions`), sorted by priority (higher first, stable),
//! duplicate names refused; the schema from the schema stage, then the
//! runtime stage against the built schema.
//!
//! An extension's parts are functions of its options (JSON, Tiptap's
//! `this.options`), so [`Extension::configure`] (a deep merge into them)
//! changes what every part makes, and [`Extension::extend`] derives a new
//! extension whose parts the builder methods replace (Tiptap's `extend`).
//! App crates register theirs by name for JS ([`register_extension`],
//! [`RichExtensionRegistry::rich_extension`] on a UI set's registry).

use std::{collections::HashMap, fmt, sync::Arc};

use nsh_core::{
    element::Registry,
    prelude::{global, try_global},
};
use serde_json::{Map, Value};

use super::{
    input_rules::{InputRule, input_rules as input_rules_plugin},
    keymap::keymap as keymap_plugin,
    paste_rules::{PasteRule, paste_rules as paste_rules_plugin},
    starter::merge_keymaps,
};
use crate::rich_editor::{
    commands::{BoxCommand, CommandFactory, CommandRegistry},
    model::{AttrSpec, MarkSpec, NodeSpec, Schema, SchemaSpec},
    state::Plugin,
};

/// What an extension adds to the schema (Tiptap's `Extension`, `Node` and
/// `Mark`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ExtensionKind {
    /// Behavior only, no type of its own.
    #[default]
    Extension,
    /// A node type, named as the extension.
    Node,
    /// A mark type, named as the extension.
    Mark,
}

/// What an extension's runtime parts are made with: its name and options,
/// the editor's schema and its named commands (the builtin ones and every
/// extension's).
#[derive(Clone, Copy)]
#[non_exhaustive]
pub struct ExtensionContext<'a> {
    /// The extension's name.
    pub name: &'a str,
    /// Its options (defaults merged with what `configure` gave).
    pub options: &'a Value,
    /// The editor's schema.
    pub schema: &'a Schema,
    /// The editor's named commands.
    pub commands: &'a CommandRegistry,
}

impl fmt::Debug for ExtensionContext<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExtensionContext")
            .field("name", &self.name)
            .field("options", self.options)
            .finish_non_exhaustive()
    }
}

/// Attributes an extension adds to other types (Tiptap's
/// `addGlobalAttributes`): each of `attributes` on each type of `types`
/// the schema has, replacing an attribute of the same name.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct GlobalAttributes {
    /// The node or mark types' names.
    pub types: Vec<String>,
    /// The attributes, in order.
    pub attributes: Vec<(String, AttrSpec)>,
}

impl GlobalAttributes {
    /// `attributes` on each of `types`.
    pub fn new(types: Vec<String>, attributes: Vec<(String, AttrSpec)>) -> Self {
        Self { types, attributes }
    }
}

/// Why extensions could not make an editor.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ExtensionError {
    /// Two extensions of one name (the name).
    DuplicateName(String),
    /// No extension of the name is registered or built in (the name).
    Unknown(String),
    /// The schema the extensions make is invalid (why).
    Schema(String),
    /// A part could not be made (the extension's name, why).
    Part(String, String),
}

impl fmt::Display for ExtensionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateName(name) => write!(f, "two extensions are named `{name}`"),
            Self::Unknown(name) => write!(f, "no extension is named `{name}`"),
            Self::Schema(why) => write!(f, "the extensions' schema is invalid: {why}"),
            Self::Part(name, why) => write!(f, "extension `{name}`: {why}"),
        }
    }
}

impl std::error::Error for ExtensionError {}

type OptionsFn<T> = Arc<dyn Fn(&Value) -> T + Send + Sync>;
type RuntimeFn<T> = Arc<dyn Fn(&ExtensionContext<'_>) -> T + Send + Sync>;

/// One extension: a name, a kind, a priority, options, and the parts it
/// contributes, each a function of the options (and, for the runtime
/// parts, of the built schema). Made with [`Extension::new`],
/// [`Extension::node`] or [`Extension::mark`] and the `add_*` builder
/// methods; cheap to clone (its parts are shared).
#[derive(Clone)]
#[non_exhaustive]
pub struct Extension {
    /// Its name (a node's or mark's is its type's).
    pub name: String,
    /// What it adds to the schema.
    pub kind: ExtensionKind,
    /// Its rank: higher comes first in the schema, in keymaps and rules
    /// (100 by default, Tiptap's).
    pub priority: i32,
    /// Its options: the defaults with what [`Extension::configure`] merged
    /// in.
    pub options: Value,
    /// Whether its node is the document's (Tiptap's `topNode`).
    pub top_node: bool,
    node: Option<OptionsFn<NodeSpec>>,
    mark: Option<OptionsFn<MarkSpec>>,
    extensions: Option<OptionsFn<Vec<Extension>>>,
    global_attributes: Option<OptionsFn<Vec<GlobalAttributes>>>,
    keyboard_shortcuts: Option<RuntimeFn<Vec<(String, BoxCommand)>>>,
    input_rules: Option<RuntimeFn<Vec<InputRule>>>,
    paste_rules: Option<RuntimeFn<Vec<PasteRule>>>,
    plugins: Option<RuntimeFn<Vec<Plugin>>>,
    commands: Option<OptionsFn<Vec<(String, CommandFactory)>>>,
    storage: Option<OptionsFn<Value>>,
}

/// Tiptap's default priority.
pub const DEFAULT_PRIORITY: i32 = 100;

impl Default for Extension {
    fn default() -> Self {
        Self {
            name: String::new(),
            kind: ExtensionKind::Extension,
            priority: DEFAULT_PRIORITY,
            options: Value::Object(Map::new()),
            top_node: false,
            node: None,
            mark: None,
            extensions: None,
            global_attributes: None,
            keyboard_shortcuts: None,
            input_rules: None,
            paste_rules: None,
            plugins: None,
            commands: None,
            storage: None,
        }
    }
}

impl fmt::Debug for Extension {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Extension")
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("priority", &self.priority)
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

/// `patch` merged into `base`: objects key by key, recursively; anything
/// else replaces (Tiptap's `mergeDeep`).
pub fn merge_options(base: &Value, patch: &Value) -> Value {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            let mut out = base.clone();
            for (key, value) in patch {
                let merged = match out.get(key) {
                    Some(old) => merge_options(old, value),
                    None => value.clone(),
                };
                out.insert(key.clone(), merged);
            }
            Value::Object(out)
        }
        (_, Value::Null) => base.clone(),
        _ => patch.clone(),
    }
}

impl Extension {
    /// A behavior-only extension named `name` (Tiptap's
    /// `Extension.create({ name })`).
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }

    /// A node extension: the node type `name` with the spec `spec` makes
    /// from the options (Tiptap's `Node.create`).
    pub fn node(
        name: impl Into<String>,
        spec: impl Fn(&Value) -> NodeSpec + Send + Sync + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            kind: ExtensionKind::Node,
            node: Some(Arc::new(spec)),
            ..Self::default()
        }
    }

    /// A mark extension: the mark type `name` with the spec `spec` makes
    /// from the options (Tiptap's `Mark.create`).
    pub fn mark(
        name: impl Into<String>,
        spec: impl Fn(&Value) -> MarkSpec + Send + Sync + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            kind: ExtensionKind::Mark,
            mark: Some(Arc::new(spec)),
            ..Self::default()
        }
    }

    /// A copy with `options` merged into its options (Tiptap's
    /// `configure`).
    #[must_use]
    pub fn configure(&self, options: Value) -> Self {
        let mut out = self.clone();
        out.options = merge_options(&self.options, &options);
        out
    }

    /// A new extension derived from this one: the same parts until the
    /// builder methods replace them (Tiptap's `extend`; keep a clone of
    /// this one to call its parts from the new ones).
    #[must_use]
    pub fn extend(&self) -> Self {
        self.clone()
    }

    /// Renamed `name` (a node's or mark's type is renamed with it).
    #[must_use]
    pub fn named(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }

    /// With priority `priority`.
    #[must_use]
    pub fn with_priority(mut self, priority: i32) -> Self {
        self.priority = priority;
        self
    }

    /// With the default options `options` (Tiptap's `addOptions`), what
    /// was configured merged over them.
    #[must_use]
    pub fn with_options(mut self, options: Value) -> Self {
        self.options = merge_options(&options, &self.options);
        self
    }

    /// Makes it a node extension whose spec `spec` makes (replacing its
    /// node or mark spec, as an `extend` overriding the type).
    #[must_use]
    pub fn with_node_spec(
        mut self,
        spec: impl Fn(&Value) -> NodeSpec + Send + Sync + 'static,
    ) -> Self {
        self.kind = ExtensionKind::Node;
        self.node = Some(Arc::new(spec));
        self.mark = None;
        self
    }

    /// Makes it a mark extension whose spec `spec` makes.
    #[must_use]
    pub fn with_mark_spec(
        mut self,
        spec: impl Fn(&Value) -> MarkSpec + Send + Sync + 'static,
    ) -> Self {
        self.kind = ExtensionKind::Mark;
        self.mark = Some(Arc::new(spec));
        self.node = None;
        self
    }

    /// Its node is the document's.
    #[must_use]
    pub fn with_top_node(mut self) -> Self {
        self.top_node = true;
        self
    }

    /// The extensions it brings (Tiptap's `addExtensions`: StarterKit's).
    #[must_use]
    pub fn add_extensions(
        mut self,
        f: impl Fn(&Value) -> Vec<Extension> + Send + Sync + 'static,
    ) -> Self {
        self.extensions = Some(Arc::new(f));
        self
    }

    /// The attributes it adds to other types (Tiptap's
    /// `addGlobalAttributes`).
    #[must_use]
    pub fn add_global_attributes(
        mut self,
        f: impl Fn(&Value) -> Vec<GlobalAttributes> + Send + Sync + 'static,
    ) -> Self {
        self.global_attributes = Some(Arc::new(f));
        self
    }

    /// Its key bindings (Tiptap's `addKeyboardShortcuts`).
    #[must_use]
    pub fn add_keyboard_shortcuts(
        mut self,
        f: impl Fn(&ExtensionContext<'_>) -> Vec<(String, BoxCommand)> + Send + Sync + 'static,
    ) -> Self {
        self.keyboard_shortcuts = Some(Arc::new(f));
        self
    }

    /// Its input rules (Tiptap's `addInputRules`).
    #[must_use]
    pub fn add_input_rules(
        mut self,
        f: impl Fn(&ExtensionContext<'_>) -> Vec<InputRule> + Send + Sync + 'static,
    ) -> Self {
        self.input_rules = Some(Arc::new(f));
        self
    }

    /// Its paste rules (Tiptap's `addPasteRules`).
    #[must_use]
    pub fn add_paste_rules(
        mut self,
        f: impl Fn(&ExtensionContext<'_>) -> Vec<PasteRule> + Send + Sync + 'static,
    ) -> Self {
        self.paste_rules = Some(Arc::new(f));
        self
    }

    /// Its plugins (Tiptap's `addProseMirrorPlugins`).
    #[must_use]
    pub fn add_plugins(
        mut self,
        f: impl Fn(&ExtensionContext<'_>) -> Vec<Plugin> + Send + Sync + 'static,
    ) -> Self {
        self.plugins = Some(Arc::new(f));
        self
    }

    /// Its named commands (Tiptap's `addCommands`): factories making each
    /// from its JSON arguments and the schema.
    #[must_use]
    pub fn add_commands(
        mut self,
        f: impl Fn(&Value) -> Vec<(String, CommandFactory)> + Send + Sync + 'static,
    ) -> Self {
        self.commands = Some(Arc::new(f));
        self
    }

    /// Its storage's first value (Tiptap's `addStorage`).
    #[must_use]
    pub fn add_storage(mut self, f: impl Fn(&Value) -> Value + Send + Sync + 'static) -> Self {
        self.storage = Some(Arc::new(f));
        self
    }

    /// Its node type's spec, for a node extension.
    pub fn node_spec(&self) -> Option<NodeSpec> {
        self.node.as_ref().map(|f| f(&self.options))
    }

    /// Its mark type's spec, for a mark extension.
    pub fn mark_spec(&self) -> Option<MarkSpec> {
        self.mark.as_ref().map(|f| f(&self.options))
    }

    /// The extensions it brings.
    pub fn children(&self) -> Vec<Extension> {
        self.extensions
            .as_ref()
            .map(|f| f(&self.options))
            .unwrap_or_default()
    }

    /// The attributes it adds to other types.
    pub fn global_attributes(&self) -> Vec<GlobalAttributes> {
        self.global_attributes
            .as_ref()
            .map(|f| f(&self.options))
            .unwrap_or_default()
    }

    fn cx<'a>(&'a self, schema: &'a Schema, commands: &'a CommandRegistry) -> ExtensionContext<'a> {
        ExtensionContext {
            name: &self.name,
            options: &self.options,
            schema,
            commands,
        }
    }

    /// Its key bindings for `schema`.
    pub fn keyboard_shortcuts(
        &self,
        schema: &Schema,
        commands: &CommandRegistry,
    ) -> Vec<(String, BoxCommand)> {
        self.keyboard_shortcuts
            .as_ref()
            .map(|f| f(&self.cx(schema, commands)))
            .unwrap_or_default()
    }

    /// Its input rules for `schema`.
    pub fn input_rules(&self, schema: &Schema, commands: &CommandRegistry) -> Vec<InputRule> {
        self.input_rules
            .as_ref()
            .map(|f| f(&self.cx(schema, commands)))
            .unwrap_or_default()
    }

    /// Its paste rules for `schema`.
    pub fn paste_rules(&self, schema: &Schema, commands: &CommandRegistry) -> Vec<PasteRule> {
        self.paste_rules
            .as_ref()
            .map(|f| f(&self.cx(schema, commands)))
            .unwrap_or_default()
    }

    /// Its plugins for `schema`.
    pub fn plugins(&self, schema: &Schema, commands: &CommandRegistry) -> Vec<Plugin> {
        self.plugins
            .as_ref()
            .map(|f| f(&self.cx(schema, commands)))
            .unwrap_or_default()
    }

    /// Its named commands.
    pub fn commands(&self) -> Vec<(String, CommandFactory)> {
        self.commands
            .as_ref()
            .map(|f| f(&self.options))
            .unwrap_or_default()
    }

    /// Its storage's first value (`null` without one).
    pub fn storage(&self) -> Value {
        self.storage
            .as_ref()
            .map_or(Value::Null, |f| f(&self.options))
    }
}

// --- Resolving ---------------------------------------------------------------

/// Extensions resolved for one editor: flattened, sorted, their schema
/// built, their commands collected; the runtime parts are made from it.
#[derive(Clone)]
pub struct ExtensionManager {
    extensions: Vec<Extension>,
    schema: Schema,
    commands: Arc<CommandRegistry>,
}

impl fmt::Debug for ExtensionManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExtensionManager")
            .field(
                "extensions",
                &self.extensions.iter().map(|e| &e.name).collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

/// Tiptap's core extensions, which every editor has unless left out: the
/// core keymap (Enter, Backspace, Delete, select all, the platform's
/// editing keys) with its `clearDocument` plugin.
pub fn core_extensions() -> Vec<Extension> {
    vec![super::kit::core_keymap()]
}

impl ExtensionManager {
    /// `extensions` resolved as they are (no core extensions).
    pub fn new(extensions: Vec<Extension>) -> Result<Self, ExtensionError> {
        let extensions = Self::resolve(extensions)?;
        let spec = Self::schema_spec(&extensions);
        let schema = Schema::new(spec).map_err(|e| ExtensionError::Schema(e.to_string()))?;
        let mut commands = CommandRegistry::new();
        commands.extend(&CommandRegistry::builtin());
        // Later (lower) extensions replace earlier commands of a name, as
        // Tiptap's command table is built.
        for extension in &extensions {
            for (name, factory) in extension.commands() {
                commands.register(name, move |args: &Value, schema: &Schema| {
                    factory(args, schema)
                });
            }
        }
        Ok(Self {
            extensions,
            schema,
            commands: Arc::new(commands),
        })
    }

    /// `extensions` after the core extensions ([`core_extensions`]), as a
    /// Tiptap editor has them.
    pub fn with_core(extensions: Vec<Extension>) -> Result<Self, ExtensionError> {
        let mut all = core_extensions();
        all.extend(extensions);
        Self::new(all)
    }

    /// `extensions` flattened (each followed by the ones it brings), sorted
    /// by priority (higher first; equal ones keep their order), with
    /// duplicate names refused.
    pub fn resolve(extensions: Vec<Extension>) -> Result<Vec<Extension>, ExtensionError> {
        fn flatten(extensions: Vec<Extension>, out: &mut Vec<Extension>) {
            for extension in extensions {
                let children = extension.children();
                out.push(extension);
                flatten(children, out);
            }
        }
        let mut flat = Vec::new();
        flatten(extensions, &mut flat);
        flat.sort_by_key(|e| std::cmp::Reverse(e.priority));
        let mut seen = std::collections::HashSet::new();
        for extension in &flat {
            if !seen.insert(extension.name.as_str()) {
                return Err(ExtensionError::DuplicateName(extension.name.clone()));
            }
        }
        Ok(flat)
    }

    /// The schema spec of resolved `extensions`: their node and mark types
    /// in order, with the global attributes added; the first top node
    /// extension's node is the document's.
    pub fn schema_spec(extensions: &[Extension]) -> SchemaSpec {
        let mut spec = SchemaSpec::default();
        for extension in extensions {
            if let Some(node) = extension.node_spec() {
                if extension.top_node && spec.top_node.is_none() {
                    spec.top_node = Some(extension.name.clone());
                }
                spec.nodes.push((extension.name.clone(), node));
            } else if let Some(mark) = extension.mark_spec() {
                spec.marks.push((extension.name.clone(), mark));
            }
        }
        for extension in extensions {
            for global in extension.global_attributes() {
                for ty in &global.types {
                    let attrs = spec
                        .nodes
                        .iter_mut()
                        .find(|(name, _)| name == ty)
                        .map(|(_, node)| &mut node.attrs)
                        .or_else(|| {
                            spec.marks
                                .iter_mut()
                                .find(|(name, _)| name == ty)
                                .map(|(_, mark)| &mut mark.attrs)
                        });
                    let Some(attrs) = attrs else { continue };
                    for (name, attr) in &global.attributes {
                        match attrs.iter_mut().find(|(n, _)| n == name) {
                            Some(slot) => slot.1 = attr.clone(),
                            None => attrs.push((name.clone(), attr.clone())),
                        }
                    }
                }
            }
        }
        spec
    }

    /// The resolved extensions, in schema order.
    pub fn extensions(&self) -> &[Extension] {
        &self.extensions
    }

    /// The extension named `name`.
    pub fn extension(&self, name: &str) -> Option<&Extension> {
        self.extensions.iter().find(|e| e.name == name)
    }

    /// The schema the extensions make.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// The editor's named commands: the builtin ones and the extensions'.
    pub fn commands(&self) -> &Arc<CommandRegistry> {
        &self.commands
    }

    /// The extensions in the order their runtime parts run: Tiptap's,
    /// higher priority first and, among equal ones, later ones first (so
    /// an app's extension listed after the starter kit binds keys before
    /// it, and the core's run last).
    pub fn runtime_order(&self) -> Vec<&Extension> {
        let mut order: Vec<&Extension> = self.extensions.iter().rev().collect();
        order.sort_by_key(|e| std::cmp::Reverse(e.priority));
        order
    }

    /// Every extension's key bindings, one group each, in runtime order.
    pub fn keymap_groups(&self) -> Vec<Vec<(String, BoxCommand)>> {
        self.runtime_order()
            .into_iter()
            .map(|e| e.keyboard_shortcuts(&self.schema, &self.commands))
            .filter(|g| !g.is_empty())
            .collect()
    }

    /// Every extension's key bindings merged into one keymap: a key bound
    /// by several runs their commands in runtime order until one applies.
    pub fn keymap(&self) -> Vec<(String, BoxCommand)> {
        merge_keymaps(self.keymap_groups())
    }

    /// Every extension's input rules, in runtime order.
    pub fn input_rules(&self) -> Vec<InputRule> {
        self.runtime_order()
            .into_iter()
            .flat_map(|e| e.input_rules(&self.schema, &self.commands))
            .collect()
    }

    /// Every extension's paste rules, in runtime order.
    pub fn paste_rules(&self) -> Vec<PasteRule> {
        self.runtime_order()
            .into_iter()
            .flat_map(|e| e.paste_rules(&self.schema, &self.commands))
            .collect()
    }

    /// The editor's plugins: the input rules' plugin, the paste rules'
    /// plugin, one keymap plugin of every extension's bindings
    /// ([`ExtensionManager::keymap`]: a key's commands in runtime order),
    /// then each extension's own plugins in runtime order. One keymap
    /// rather than Tiptap's one per extension, so a binding with Shift
    /// spelled out (`Mod-Shift-b`) wins over another extension's binding
    /// of the shifted character (`Mod-B`).
    pub fn plugins(&self) -> Vec<Plugin> {
        let mut plugins = Vec::new();
        let input = self.input_rules();
        if !input.is_empty() {
            plugins.push(input_rules_plugin(input));
        }
        let paste = self.paste_rules();
        if !paste.is_empty() {
            plugins.push(paste_rules_plugin(paste));
        }
        let keys = self.keymap();
        if !keys.is_empty() {
            plugins.push(keymap_plugin(keys));
        }
        for extension in self.runtime_order() {
            plugins.extend(extension.plugins(&self.schema, &self.commands));
        }
        plugins
    }

    /// Each extension's storage's first value, by name (those with one).
    pub fn storage(&self) -> HashMap<String, Value> {
        self.extensions
            .iter()
            .filter_map(|e| {
                let value = e.storage();
                (!value.is_null()).then(|| (e.name.clone(), value))
            })
            .collect()
    }
}

// --- Extensions by name ------------------------------------------------------

type MakeExtension = Arc<dyn Fn() -> Extension + Send + Sync>;

/// The extensions an engine's UI sets registered, by name.
#[derive(Clone, Default)]
struct RegisteredExtensions {
    by_name: HashMap<String, MakeExtension>,
}

/// Registers `make` as the extension `name` on this engine, for JS to use
/// (`richExtension("name")`) and to resolve by name ([`extension_named`]);
/// a later registration of a name replaces an earlier one. Call it from a
/// UI set's setup ([`RichExtensionRegistry::rich_extension`]).
///
/// # Panics
///
/// Outside an engine (where no reactive runtime runs).
pub fn register_extension(name: &str, make: impl Fn() -> Extension + Send + Sync + 'static) {
    let make: MakeExtension = Arc::new(make);
    let name = name.to_owned();
    global::<RegisteredExtensions>().update(move |r| {
        r.by_name.insert(name, make);
    });
}

/// The extension `name`: one this engine's UI sets registered, else a
/// built-in one (`starterKit`, `bold`, `heading`, ...).
pub fn extension_named(name: &str) -> Option<Extension> {
    if let Some(registered) = try_global::<RegisteredExtensions>()
        && let Some(make) = registered.with_untracked(|r| r.by_name.get(name).cloned())
    {
        return Some(make());
    }
    super::kit::builtin(name)
}

/// Rich editor extensions on a UI set's registry: what an app's crate
/// calls from its `#[native_module]` function.
pub trait RichExtensionRegistry {
    /// Registers `make` as the rich editor extension `name` on every engine
    /// serving the set ([`register_extension`] in the set's setup).
    fn rich_extension(
        &mut self,
        name: &'static str,
        make: impl Fn() -> Extension + Send + Sync + 'static,
    ) -> &mut Self;
}

impl RichExtensionRegistry for Registry {
    fn rich_extension(
        &mut self,
        name: &'static str,
        make: impl Fn() -> Extension + Send + Sync + 'static,
    ) -> &mut Self {
        let make: MakeExtension = Arc::new(make);
        self.setup(move || {
            let make = make.clone();
            register_extension(name, move || make());
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rich_editor::{
        commands::command,
        model::NodeSpec,
        state::{EditorState, EditorStateConfig},
    };

    fn doc() -> Extension {
        Extension::node("doc", |_| NodeSpec {
            content: Some("block+".into()),
            ..Default::default()
        })
        .with_top_node()
    }

    fn block(name: &str) -> Extension {
        Extension::node(name, |_| NodeSpec {
            content: Some("text*".into()),
            group: Some("block".into()),
            ..Default::default()
        })
    }

    fn text() -> Extension {
        Extension::node("text", |_| NodeSpec {
            group: Some("inline".into()),
            ..Default::default()
        })
    }

    #[test]
    fn options_merge_deeply() {
        let base = Extension::new("x").with_options(json!({"a": {"b": 1, "c": 2}, "d": 3}));
        let configured = base.configure(json!({"a": {"b": 5}}));
        assert_eq!(configured.options, json!({"a": {"b": 5, "c": 2}, "d": 3}));
        assert_eq!(base.options["a"]["b"], json!(1));
        // Defaults given after configure stay under what was configured.
        let late = Extension::new("y")
            .configure(json!({"a": 1}))
            .with_options(json!({"a": 0, "b": 2}));
        assert_eq!(late.options, json!({"a": 1, "b": 2}));
    }

    #[test]
    fn priority_sorts_and_children_follow_their_parent() {
        let parent = Extension::new("kit").add_extensions(|_| {
            vec![
                Extension::new("one"),
                Extension::new("two").with_priority(1000),
            ]
        });
        let names: Vec<String> = ExtensionManager::resolve(vec![
            Extension::new("first"),
            parent,
            Extension::new("low").with_priority(50),
        ])
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
        assert_eq!(names, ["two", "first", "kit", "one", "low"]);
    }

    #[test]
    fn duplicate_names_are_refused() {
        let error =
            ExtensionManager::resolve(vec![Extension::new("a"), Extension::new("a")]).unwrap_err();
        assert_eq!(error, ExtensionError::DuplicateName("a".into()));
    }

    #[test]
    fn global_attributes_reach_their_types() {
        let align = Extension::new("align").add_global_attributes(|_| {
            vec![GlobalAttributes::new(
                vec!["para".into(), "missing".into()],
                vec![(
                    "align".into(),
                    AttrSpec {
                        default: Some(Value::Null),
                        ..Default::default()
                    },
                )],
            )]
        });
        let manager = ExtensionManager::new(vec![doc(), block("para"), text(), align]).unwrap();
        let para = manager.schema().node_type("para").unwrap();
        assert!(para.spec().attrs.iter().any(|(n, _)| n == "align"));
        assert_eq!(manager.schema().top_node_type().name(), "doc");
    }

    #[test]
    fn runtime_order_runs_later_extensions_first() {
        let bound = |name: &'static str| {
            Extension::new(name)
                .add_keyboard_shortcuts(|_| vec![("Mod-k".into(), command(|_, _| false))])
        };
        let manager = ExtensionManager::new(vec![
            doc(),
            block("para"),
            text(),
            bound("early"),
            bound("late"),
            bound("high").with_priority(200),
        ])
        .unwrap();
        let order: Vec<&str> = manager
            .runtime_order()
            .into_iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(order, ["high", "late", "early", "text", "para", "doc"]);
        assert_eq!(manager.keymap_groups().len(), 3);
        assert_eq!(manager.keymap().len(), 1);
        assert_eq!(manager.plugins().len(), 1);
    }

    #[test]
    fn extension_commands_join_the_builtin_ones() {
        let ext = Extension::new("shout").add_commands(|options| {
            let word = options["word"].as_str().unwrap_or("hey").to_owned();
            let factory: CommandFactory = Arc::new(move |_, _| {
                let word = word.clone();
                Ok(command(move |state, dispatch| {
                    if let Some(dispatch) = dispatch {
                        let mut tr = state.tr();
                        tr.insert_text(&word, None, None);
                        dispatch(tr);
                    }
                    true
                }))
            });
            vec![("shout".into(), factory)]
        });
        let manager = ExtensionManager::new(vec![
            doc(),
            block("para"),
            text(),
            ext.configure(json!({"word": "hi"})),
        ])
        .unwrap();
        assert!(manager.commands().contains("shout"));
        assert!(manager.commands().contains("toggleMark"));
        let state = EditorState::create(EditorStateConfig::new(manager.schema().clone())).unwrap();
        let shout = manager
            .commands()
            .make("shout", &Value::Null, manager.schema())
            .unwrap();
        let mut next = None;
        assert!(shout(&state, Some(&mut |tr| next = Some(tr))));
        assert_eq!(
            state.apply(next.unwrap()).unwrap().doc().text_content(),
            "hi"
        );
    }

    #[test]
    fn names_resolve_to_builtins_off_an_engine() {
        assert!(extension_named("starterKit").is_some());
        assert!(extension_named("bold").is_some());
        assert!(extension_named("nope").is_none());
    }
}
