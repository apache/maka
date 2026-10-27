//! The native ES modules apps import: nsh's own (`nsh`,
//! `nsh:rt`, `nsh/device`, `nsh/accessibility`, `nsh/keymap`, ...;
//! [`nsh_core::js::NATIVE_MODULES`])
//! and those of registries (`Registry::specifier`): the UI sets a host
//! serves (`nsh/base`, an app's own) and the runtime's (`nsh/android`, ...), whose
//! components, modules and re-exports become exports (`components.rs`).
//! A module of both kinds (`nsh/accessibility`) has the exports of both.
//!
//! The exports are made when a bundle first imports the module. QuickJS-NG
//! resolves imports when it compiles a module, so the bytecode compiler
//! installs the same loader (a module then only declares its export names;
//! nothing runs).
//!
//! The loader also compiles the chunks of a split bundle (`chunks.rs`): the
//! code the host gave for a name that is not a native module.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ffi::{CStr, CString, c_char, c_int, c_void},
    sync::Arc,
};

use nsh_core::{
    decl,
    element::{ComponentSpec, DECLARATIONS, ModuleSpec, Registry, description::SetDescription},
};
use rquickjs::{Ctx, JsLifetime, Module, qjs};

use crate::{
    animated, canvas, components, desktop, dom, env, keymap, list, platform_modules,
    reactive::{self, Native},
    touch,
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

/// A value nsh's own modules export.
#[derive(Clone, Copy)]
pub(crate) enum Export {
    /// A native function and its `length`.
    Function(Native, c_int),
    /// A value made when the module is first imported (owned).
    Value(fn(*mut JsContext) -> JsValue),
}

/// The TypeScript declaration of an export (`.nsh/types`, assembled by
/// `declarations.rs`): documentation as plain text, the rest as it follows
/// the export's name.
#[derive(Clone, Copy)]
pub(crate) enum Ts {
    /// A function and its signatures (overloads): `<T>(value: T): Signal<T>`.
    Function(&'static str, &'static [&'static str]),
    /// A value and its type.
    Const(&'static str, &'static str),
    /// A class: ` extends Base { ... }` or ` { ... }`.
    Class(&'static str, &'static str),
    /// Not declared: what only compiled code or development bundles import.
    Internal,
}

impl Ts {
    // Constructors for the tables: the text is left out of builds without
    // declarations (`nsh_core::element::DECLARATIONS`).

    /// [`Ts::Function`].
    pub(crate) const fn function(doc: &'static str, signatures: &'static [&'static str]) -> Ts {
        if DECLARATIONS {
            Ts::Function(doc, signatures)
        } else {
            Ts::Internal
        }
    }

    /// [`Ts::Const`].
    pub(crate) const fn value(doc: &'static str, ty: &'static str) -> Ts {
        if DECLARATIONS {
            Ts::Const(doc, ty)
        } else {
            Ts::Internal
        }
    }

    /// [`Ts::Class`].
    pub(crate) const fn class(doc: &'static str, body: &'static str) -> Ts {
        if DECLARATIONS {
            Ts::Class(doc, body)
        } else {
            Ts::Internal
        }
    }
}

/// An export: its name, how it is made and its declaration.
pub(crate) type Item = (&'static str, Export, Ts);

/// One of nsh's own modules.
pub(crate) struct NativeModule {
    pub(crate) name: &'static str,
    pub(crate) exports: &'static [Item],
    /// The modules whose exports this one serves too, the same values (one
    /// per VM): `nsh` serves the primitives `nsh/image`, `nsh/list`, ...
    /// exported first.
    pub(crate) also: &'static [&'static str],
    /// The module that serves this one's exports (`nsh`): it is no module
    /// apps import, only the source of those exports and their types.
    pub(crate) moved_to: Option<&'static str>,
    /// The module's own TypeScript types (interfaces, type aliases), next to
    /// the declarations of its exports.
    pub(crate) types: &'static str,
}

/// `nsh`: the API apps write against.
const NSH: &[Item] = &[
    crate::env::TOKEN_EXPORT,
    (
        "signal",
        Export::Function(reactive::signal, 2),
        Ts::function(
            "A signal holding `value`.",
            &[
                "<T>(value: T, options?: SignalOptions<T>): Signal<T>",
                "<T = undefined>(): Signal<T | undefined>",
            ],
        ),
    ),
    (
        "computed",
        Export::Function(reactive::computed, 2),
        Ts::function(
            "A value derived from signals, computed again when they change (and read).",
            &["<T>(fn: (previous: T | undefined) => T, options?: SignalOptions<T>): Accessor<T>"],
        ),
    ),
    (
        "effect",
        Export::Function(reactive::effect, 1),
        Ts::function(
            "Runs `fn` after rendering, and again when what it read changes. A function `fn`\nreturns is its cleanup (`cleanup(f)`): it runs before `fn` runs again, or when the\neffect goes away.",
            &["(fn: () => void | (() => void)): void"],
        ),
    ),
    (
        "batch",
        Export::Function(reactive::batch, 1),
        Ts::function(
            "Runs `fn`, applying its writes together at the end.",
            &["<T>(fn: () => T): T"],
        ),
    ),
    (
        "untracked",
        Export::Function(reactive::untrack, 1),
        Ts::function(
            "Runs `fn` without tracking what it reads.",
            &["<T>(fn: () => T): T"],
        ),
    ),
    (
        "cleanup",
        Export::Function(reactive::on_cleanup, 1),
        Ts::function(
            "Runs `fn` before the current effect or component runs again or goes away.",
            &["(fn: () => void): void"],
        ),
    ),
    (
        "inputAction",
        Export::Function(crate::input_action::input_action, 2),
        Ts::function(
            "Captures `args` as deeply frozen JSON and returns a callback that calls `handler`\nwith that snapshot as its only argument, ignoring incoming event arguments. Capture\nreads getters and Proxy traps, sorts object keys, and allows at most 64 levels,\n1048576 entries and 8 MiB of canonical UTF-8 JSON. Missing, undefined, function,\nsymbol or bigint root arguments throw. In objects, undefined, function and symbol\nfields are omitted; in arrays they become null. Non-finite numbers and other\nunsupported primitive values become null. The handler must be a function other than\nan input action. Ambient reads may only reject an action; they must never retarget\nit or change the meaning of its captured arguments.",
            &["<A>(handler: (args: A) => unknown, args: A): () => void"],
        ),
    ),
    (
        "resource",
        Export::Function(crate::resource::resource, 3),
        Ts::function(
            "A value loaded asynchronously by `fetcher`, again whenever `source` (an accessor) gives a\nnew value that is set (not `undefined`, `null` or `false`) and on `refetch()`. Only the\nlatest load counts: the one it supersedes is aborted (`info.signal`), and so is the running\none when its owner goes away. The value stays while loading again and after a failure.",
            &[
                "<T>(fetcher: (info: ResourceInfo) => T | Promise<T>, options: ResourceOptions<T> & { initialValue: T }): InitializedResource<T>",
                "<T>(fetcher: (info: ResourceInfo) => T | Promise<T>, options?: ResourceOptions<T>): Resource<T>",
                "<S, T>(source: ResourceSource<S>, fetcher: (source: S, info: ResourceInfo) => T | Promise<T>, options: ResourceOptions<T> & { initialValue: T }): InitializedResource<T>",
                "<S, T>(source: ResourceSource<S>, fetcher: (source: S, info: ResourceInfo) => T | Promise<T>, options?: ResourceOptions<T>): Resource<T>",
            ],
        ),
    ),
    (
        "context",
        Export::Function(dom::context, 1),
        Ts::function(
            "A context with a default value.",
            &["<T>(defaultValue: T): Context<T>"],
        ),
    ),
    (
        "importModule",
        Export::Function(crate::chunks::import_module, 2),
        Ts::function(
            "Imports a module supplied by the host into this app's VM. The id and optional\ndependencies are chunk file names, such as `plugin.js`. Imports of the same id\nshare one evaluation; use a new id when its code changes.",
            &[
                "<T = Record<string, unknown>>(id: string, dependencies?: readonly string[]): Promise<T>",
            ],
        ),
    ),
    (
        "mount",
        Export::Function(dom::mount, 2),
        Ts::function(
            "Renders `app` into the surface; returns a function that removes it.",
            &["<P extends object>(app: Component<P>, props?: P): () => void"],
        ),
    ),
    (
        "split",
        Export::Function(dom::split, 2),
        Ts::function(
            "`[picked, rest]`: the props named in `keys` and the others, both still\nfollowing what they read (a component passing the rest on: `<Input {...rest} />`).",
            &[
                "<T extends object, K extends readonly (keyof T)[]>(props: T, keys: K): [Pick<T, K[number]>, Omit<T, K[number]>]",
            ],
        ),
    ),
    (
        "ErrorBoundary",
        Export::Function(dom::error_boundary, 1),
        Ts::function(
            "Its children, or `fallback` once something under them threw (a component's body, a\nbinding, an effect, a listener): what failed goes, and `fallback(error, reset)` shows the\nthrown value; `reset()` renders the children again. A fallback that takes no arguments\nis shown as is. What throws in the fallback goes to the boundary above.",
            &[
                "(props: { fallback: JSX.Element | ((error: unknown, reset: () => void) => JSX.Element); children?: JSX.Element }): JSX.Element",
            ],
        ),
    ),
    (
        "View",
        Export::Value(|cx| dom::host_component(cx, "view", true)),
        Ts::function(
            "A view: the box layout, styles, touches and accessibility work on\n(UIView / ViewGroup).",
            &["(props: ViewProps): YNode"],
        ),
    ),
    (
        "Text",
        Export::Value(|cx| dom::host_component(cx, "text", true)),
        Ts::function(
            "A paragraph of text; a `<Text>` in it is a span of the same paragraph, other\nelements are inline attachments.",
            &["(props: TextProps): YNode"],
        ),
    ),
    (
        "Scroll",
        Export::Value(|cx| dom::host_component(cx, "scroll", true)),
        Ts::function(
            "A native scroll view (UIScrollView / ScrollView), zoomable; for long\nlists, `List`.",
            &["(props: ScrollProps): YNode"],
        ),
    ),
    (
        "Overlay",
        Export::Value(|cx| dom::host_component(cx, "overlay", true)),
        Ts::function(
            "Its children on top of the root view it is in (the surface, or the dialog\naround it), outside its parent's layout and clipping, while it stays its\nparent's child for everything else (context, events, lifetime): popovers,\nmenus, tooltips. Without `anchor` it is a `position: fixed` box of that\nroot view; with one it goes on the `placement` side of the anchor, on the\nother when only that one has room, kept inside the safe area, and follows\nthe anchor as it moves. `onPressOutside` and `onCancel` (Escape, Android\nback) report what closes it; closing is the app's.",
            &["(props: OverlayProps): YNode"],
        ),
    ),
];

/// `nsh`'s types; its element and style types and `JSX` are `types.d.ts`'s.
const NSH_TYPES: &str = r#"export type * from "./types";

/** A value that changes over time, read by calling it (tracked). */
export interface Accessor<T> {
  (): T;
}

/** A signal: `count()` reads it, `count.set(1)` and `count.update((n) => n + 1)` write it. */
export interface Signal<T> extends Accessor<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

export interface SignalOptions<T> {
  /** When a new value counts as a change (default `===`); `false`: always. */
  equals?: false | ((previous: T, next: T) => boolean);
}

/** Where a resource is: nothing to load, loading the first value, loaded, loading again, failed. */
export type ResourceState = "unresolved" | "pending" | "ready" | "refreshing" | "errored";

/** What a resource loads from: an accessor (tracked) or a value; `undefined`, `null` and `false` load nothing. */
export type ResourceSource<S> = S | false | null | undefined | (() => S | false | null | undefined);

/** What a load is given besides the source. */
export interface ResourceInfo {
  /** Aborted when the load no longer counts (another load, or the owner went away): pass it to `fetch`. */
  signal: AbortSignal;
  /** Started by `refetch()`, the source unchanged. */
  refetching: boolean;
}

export interface ResourceOptions<T> {
  /** The value until the first load ends, which is then a refresh. */
  initialValue?: T;
}

/** What a resource does besides giving its value. */
export interface ResourceControls<T> {
  /** Whether a load runs. */
  loading(): boolean;
  /** The last load's error; `undefined` once a load gives a value. */
  error(): unknown;
  state(): ResourceState;
  /** Loads again from the same source, keeping the value meanwhile (a retry, a pull to refresh). */
  refetch(): void;
  /** Sets the value here, with no load (an optimistic update), clearing the error. */
  mutate(value: T): T;
}

/** A value loaded asynchronously: `user()` reads the latest one, `undefined` before the first. */
export interface Resource<T> extends Accessor<T | undefined>, ResourceControls<T> {}

/** A resource with an `initialValue`: it always has a value. */
export interface InitializedResource<T> extends Accessor<T>, ResourceControls<T> {}

/** A value components provide to what they render: `Theme()` reads the nearest one. */
export interface Context<T> extends Accessor<T> {
  Provider: (props: { value: T; children?: JSX.Element }) => JSX.Element;
}

/** A component: a function of its props rendering elements. */
export type Component<P = {}> = (props: P) => JSX.Element;

/**
 * The design tokens of the app's theme by name, and what `token()` gives
 * for each: a color or a font family as a string, a number. nsh declares
 * the app's (`.nsh/types/nsh/tokens.d.ts`, from `nsh.json` `"theme"`).
 */
export interface Tokens {}
"#;

/// The sources of what `nsh` serves (`NativeModule::moved_to`), kept by
/// area.
const NSH_SOURCES: &[&str] = &[
    "nsh/image",
    "nsh/list",
    "nsh/canvas",
    "nsh/webview",
    "nsh/video",
    "nsh/device",
    "nsh/accessibility",
    "nsh/native",
    "nsh/gesture",
    "nsh/animated",
    "nsh/host",
    "nsh/keymap",
];

/// The sources of what `nsh/mobile` serves, by platform.
const MOBILE_SOURCES: &[&str] = &["nsh/ios", "nsh/android"];

pub(crate) const MODULES: &[NativeModule] = &[
    NativeModule {
        name: "nsh",
        exports: NSH,
        also: NSH_SOURCES,
        moved_to: None,
        types: decl!(NSH_TYPES),
    },
    NativeModule {
        name: "nsh:rt",
        exports: dom::RT_EXPORTS,
        also: &[],
        moved_to: None,
        types: "",
    },
    NativeModule {
        name: "nsh/device",
        exports: env::DEVICE_EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(env::DEVICE_TYPES),
    },
    NativeModule {
        name: "nsh/accessibility",
        exports: env::ACCESSIBILITY_EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: "",
    },
    NativeModule {
        name: "nsh/android",
        exports: platform_modules::ANDROID_EXPORTS,
        also: &[],
        moved_to: Some("nsh/mobile"),
        types: decl!(platform_modules::ANDROID_TYPES),
    },
    NativeModule {
        name: "nsh/ios",
        exports: platform_modules::IOS_EXPORTS,
        also: &[],
        moved_to: Some("nsh/mobile"),
        types: decl!(platform_modules::IOS_TYPES),
    },
    NativeModule {
        name: "nsh/desktop",
        exports: desktop::EXPORTS,
        also: &[],
        moved_to: None,
        types: decl!(desktop::TYPES),
    },
    NativeModule {
        name: "nsh/mobile",
        exports: platform_modules::MOBILE_EXPORTS,
        also: MOBILE_SOURCES,
        moved_to: None,
        types: "",
    },
    NativeModule {
        name: "nsh/webview",
        exports: platform_modules::WEBVIEW_EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(platform_modules::WEBVIEW_TYPES),
    },
    NativeModule {
        name: "nsh/video",
        exports: platform_modules::VIDEO_EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(platform_modules::VIDEO_TYPES),
    },
    NativeModule {
        name: "nsh/native",
        exports: platform_modules::NATIVE_EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(platform_modules::NATIVE_TYPES),
    },
    NativeModule {
        name: "nsh/gesture",
        exports: touch::GESTURE_EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(touch::GESTURE_TYPES),
    },
    NativeModule {
        name: "nsh/animated",
        exports: animated::EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(animated::TYPES),
    },
    NativeModule {
        name: "nsh/canvas",
        exports: canvas::EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(canvas::TYPES),
    },
    NativeModule {
        name: "nsh/list",
        exports: list::EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(list::TYPES),
    },
    NativeModule {
        name: "nsh/image",
        exports: IMAGE_EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: "",
    },
    NativeModule {
        name: "nsh/host",
        exports: platform_modules::HOST_EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(crate::host_channel::TYPES),
    },
    NativeModule {
        name: "nsh/keymap",
        exports: keymap::EXPORTS,
        also: &[],
        moved_to: Some("nsh"),
        types: decl!(keymap::TYPES),
    },
];

/// `nsh/image`: `Image`, the image element as a component carrying the
/// functions of the runtime's module (`getSize`, `prefetch`).
const IMAGE_EXPORTS: &[Item] = &[(
    "Image",
    Export::Value(|cx| {
        let image = dom::host_component(cx, "image", true);
        components::add_runtime_functions(cx, image, "nsh", "Image");
        image
    }),
    Ts::value(
        "An image (a URL or `import logo from \"./logo.png\"`), decoded and cached\nnatively; `Image.getSize(src)` and `Image.prefetch(src)` ask about one\nwithout showing it.",
        "((props: ImageProps) => YNode) & ImageModule",
    ),
)];

/// One export of a module, as it is made.
enum Made {
    Own(Export),
    /// An export of nsh's module `.0` that another serves too (`nsh`'s
    /// `Image` is `nsh/image`'s): one value per VM, whichever module is
    /// imported first making it.
    Shared(&'static str, Export),
    /// A Rust component, with the functions of a module of the same name.
    Component(Arc<ComponentSpec>, Option<Arc<ModuleSpec>>),
    /// A module object.
    Module(Arc<ModuleSpec>),
    /// One function of a flat module, with the functions of a module of
    /// its name.
    Function(Arc<ModuleSpec>, &'static str, Option<Arc<ModuleSpec>>),
    /// A constant projected from the same generated module object.
    Constant(Arc<ModuleSpec>, &'static str),
    /// The generated module object itself.
    Default(Arc<ModuleSpec>),
    /// A Rust class (`#[class]`).
    Class(&'static nsh_core::element::ClassDef),
    /// A value supplied by this VM's embedding host.
    Value(nsh_core::element::ValueSpec),
    /// Conflicting host bindings must fail instead of choosing an authority.
    DuplicateValue,
    /// A runtime value a registry exports as it is (`safeArea`).
    Reexport(&'static str),
}

/// The modules a VM (or the bytecode compiler) serves: nsh's own, the
/// runtime's registries and the host's UI sets, and the chunks of a split
/// bundle.
pub(crate) struct ModuleTable {
    registries: Vec<Registry>,
    /// Where the host's UI sets start in `registries` (after the
    /// runtime's).
    host: usize,
    /// UI sets known by their exports' names only (the bytecode compiler's:
    /// it links imports by name and never runs the modules).
    declared: Vec<SetDescription>,
    /// Canonical host exports and their public facade, owned by this context.
    materialized: RefCell<HashMap<String, Materialized>>,
    pub(crate) chunks: RefCell<ChunkCodes>,
    /// The objects of typed modules made so far, by specifier and module:
    /// one per VM, so a module's default export, its flat exports and a
    /// global made from it (`process`) are the same values.
    objects: RefCell<HashMap<(String, &'static str), crate::web::js::V>>,
    /// The values of [`Made::Shared`] exports made so far, by (module,
    /// export).
    shared: RefCell<HashMap<(&'static str, String), crate::web::js::V>>,
}

/// Host modules are constructed once, shared by imports and `nativeModule`.
/// The facade may be mutated by JS; imports retain the canonical exports.
enum Materialized {
    Initializing,
    Ready {
        exports: Vec<(String, JsValue)>,
        object: JsValue,
    },
    Failed(JsValue),
}

/// The code of a chunk.
pub(crate) enum ChunkCode {
    Source(String),
    /// From `compile_bytecode`, trusted (as `Host::eval_bytecode`'s).
    Bytecode(Vec<u8>),
}

pub(crate) struct ChunkModule {
    pub(crate) code: ChunkCode,
    pub(crate) asset_base: Option<String>,
}

/// The chunks of a split bundle a VM knows of, by id (module name).
#[derive(Default)]
pub(crate) struct ChunkCodes {
    /// Given, not imported yet: the loader compiles them (and drops the
    /// code).
    pub(crate) code: HashMap<String, ChunkModule>,
    /// Compiled (QuickJS has the modules).
    pub(crate) loaded: HashSet<String>,
}

impl ChunkCodes {
    /// Whether chunk `id` can be imported now.
    pub(crate) fn has(&self, id: &str) -> bool {
        id == nsh_core::js::ENTRY_CHUNK || self.loaded.contains(id) || self.code.contains_key(id)
    }
}

impl ModuleTable {
    pub(crate) fn new(ui_sets: &[Registry]) -> ModuleTable {
        let mut registries: Vec<Registry> = nsh_core::runtime::registries().to_vec();
        let host = registries.len();
        registries.extend(
            ui_sets
                .iter()
                .flat_map(Registry::sets)
                .filter(|r| r.specifier().is_some())
                .cloned(),
        );
        ModuleTable {
            registries,
            host,
            declared: Vec::new(),
            materialized: RefCell::default(),
            chunks: RefCell::default(),
            objects: RefCell::default(),
            shared: RefCell::default(),
        }
    }

    /// Frees the module objects (the VM is going).
    pub(crate) fn free_objects(&self) {
        let objects = std::mem::take(&mut *self.objects.borrow_mut());
        drop(objects);
        let shared = std::mem::take(&mut *self.shared.borrow_mut());
        drop(shared);
    }

    /// The values `nsh-js` makes for the registries of module `name`.
    fn natives(&self, name: &str) -> Vec<&'static str> {
        self.registries
            .iter()
            .filter(|r| r.specifier() == Some(name))
            .flat_map(|r| r.native_value_names().iter().copied())
            .collect()
    }

    /// The default object of the typed module `name` (its flat default
    /// module's), made once per VM; `None`: it has none.
    pub(crate) fn default_object(&self, cx: *mut JsContext, name: &str) -> Option<JsValue> {
        let spec = self
            .registries
            .iter()
            .filter(|r| r.specifier() == Some(name))
            .flat_map(|r| r.module_specs())
            .find(|m| m.flat && m.default)?;
        Some(self.object(cx, name, &spec))
    }

    /// Module `spec`'s object (owned), made once per VM: its functions,
    /// getters and constants, and on a flat default module the registry's
    /// native values too.
    fn object(&self, cx: *mut JsContext, name: &str, spec: &ModuleSpec) -> JsValue {
        let key = (name.to_owned(), spec.name);
        if let Some(object) = self.objects.borrow().get(&key) {
            // SAFETY: a live value the table holds.
            return unsafe { qjs::JS_DupValue(cx, object.raw()) };
        }
        let object = components::module(cx, spec);
        // SAFETY: inline tag check.
        if unsafe { qjs::JS_IsException(object) } {
            return object;
        }
        if spec.flat {
            for f in spec.functions.iter().filter(|f| !f.getter) {
                let Some(members) = self
                    .registries
                    .iter()
                    .filter(|r| r.specifier() == Some(name))
                    .find_map(|r| r.function_members(f.name))
                else {
                    continue;
                };
                let cname = CString::new(f.name).unwrap_or_default();
                // SAFETY: a property of the object we own; the reference
                // it returns is ours to free.
                unsafe {
                    let function = qjs::JS_GetPropertyStr(cx, object, cname.as_ptr());
                    components::add_functions(cx, function, &members);
                    qjs::JS_FreeValue(cx, function);
                }
            }
        }
        if spec.flat && spec.default {
            for native in self.natives(name) {
                let value = env::reexport(cx, native);
                // SAFETY: inline tag check.
                if unsafe { qjs::JS_IsException(value) } {
                    // SAFETY: ours.
                    unsafe { qjs::JS_FreeValue(cx, object) };
                    return value;
                }
                let cname = CString::new(native).unwrap_or_default();
                // SAFETY: the object takes the value.
                unsafe { qjs::JS_SetPropertyStr(cx, object, cname.as_ptr(), value) };
            }
        }
        // SAFETY: the table keeps one reference, the caller gets another.
        let kept = unsafe { qjs::JS_DupValue(cx, object) };
        self.objects
            .borrow_mut()
            .insert(key, crate::web::js::V::own(cx, kept));
        object
    }

    /// The value of export `export` of nsh's module `module` that another
    /// module serves too (owned), made once per VM.
    fn shared(&self, cx: *mut JsContext, module: &'static str, export: &str, e: Export) -> JsValue {
        let key = (module, export.to_owned());
        if let Some(value) = self.shared.borrow().get(&key) {
            // SAFETY: a live value the table holds.
            return unsafe { qjs::JS_DupValue(cx, value.raw()) };
        }
        let value = make_own(cx, export, e);
        // SAFETY: inline tag check.
        if unsafe { qjs::JS_IsException(value) } {
            return value;
        }
        // SAFETY: the table keeps one reference, the caller gets another.
        let kept = unsafe { qjs::JS_DupValue(cx, value) };
        self.shared
            .borrow_mut()
            .insert(key, crate::web::js::V::own(cx, kept));
        value
    }

    /// The table the bytecode compiler links against: nsh's own modules,
    /// the runtime's registries and `ui_sets` by their exports' names.
    pub(crate) fn compiling(ui_sets: &[SetDescription]) -> ModuleTable {
        let registries = nsh_core::runtime::registries().to_vec();
        ModuleTable {
            // No host sets: `nativeModule` is a run-time call, never an
            // import the compiler links.
            host: registries.len(),
            registries,
            declared: ui_sets.to_vec(),
            materialized: RefCell::default(),
            chunks: RefCell::default(),
            objects: RefCell::default(),
            shared: RefCell::default(),
        }
    }

    /// Releases every value the cache owns before its context is destroyed.
    pub(crate) fn free_all(&mut self, cx: *mut JsContext) {
        for (_, module) in self.materialized.get_mut().drain() {
            // SAFETY: owned values; no JS runs after state uninstall.
            unsafe {
                match module {
                    Materialized::Ready { exports, object } => {
                        for (_, value) in exports {
                            qjs::JS_FreeValue(cx, value);
                        }
                        qjs::JS_FreeValue(cx, object);
                    }
                    Materialized::Failed(error) => qjs::JS_FreeValue(cx, error),
                    Materialized::Initializing => {}
                }
            }
        }
    }

    /// The names module `name` exports, if it is one: what the loader
    /// declares (the values are made when it is evaluated, [`init`]).
    pub(crate) fn export_names(&self, name: &str) -> Option<Vec<String>> {
        let own = self.exports(name);
        let mut found = own.is_some();
        let mut names: Vec<String> = own.into_iter().flatten().map(|(name, _)| name).collect();
        for set in self.declared.iter().filter(|s| s.specifier == name) {
            found = true;
            for export in &set.exports {
                if !names.contains(&export.name) {
                    names.push(export.name.clone());
                }
            }
        }
        found.then_some(names)
    }

    /// The exports of module `name`, if it is one.
    fn exports(&self, name: &str) -> Option<Vec<(String, Made)>> {
        let mut out: Vec<(String, Made)> = Vec::new();
        let mut found = false;
        if name == crate::hot::SPECIFIER {
            let own = crate::hot::EXPORTS.iter();
            return Some(own.map(|&(n, e, _)| (n.to_owned(), Made::Own(e))).collect());
        }
        if let Some(m) = MODULES
            .iter()
            .find(|m| m.name == name && m.moved_to.is_none())
        {
            found = true;
            let shared = m.moved_to.is_some();
            out.extend(m.exports.iter().map(|&(n, e, _)| {
                let made = if shared {
                    Made::Shared(m.name, e)
                } else {
                    Made::Own(e)
                };
                (n.to_owned(), made)
            }));
            for other in m
                .also
                .iter()
                .filter_map(|a| MODULES.iter().find(|o| o.name == *a))
            {
                out.extend(
                    other
                        .exports
                        .iter()
                        .map(|&(n, e, _)| (n.to_owned(), Made::Shared(other.name, e))),
                );
            }
        }
        for registry in self
            .registries
            .iter()
            .filter(|r| r.specifier() == Some(name))
        {
            found = true;
            registry_exports(registry, &mut out);
        }
        reject_value_conflicts(&mut out);
        // nsh's own export wins over a registry's of the same name (it
        // builds on it: `BackHandler`).
        let mut seen = std::collections::HashSet::new();
        out.retain(|(name, _)| seen.insert(name.clone()));
        found.then_some(out)
    }

    /// The exports of the UI set the host registered under `specifier`
    /// (`nativeModule`): only the host's sets, never nsh's own modules or
    /// the runtime's.
    fn host_exports(&self, specifier: &str) -> Option<Vec<(String, Made)>> {
        // Runtime registry extensions now share the canonical root module.
        // Only explicit host registrations contribute to the facade below;
        // this does not expose built-ins or revive moved module names.
        if specifier != "nsh" && MODULES.iter().any(|m| m.name == specifier) {
            return None;
        }
        let mut out = Vec::new();
        let mut found = false;
        for registry in self.registries[self.host..]
            .iter()
            .filter(|r| r.specifier() == Some(specifier))
        {
            found = true;
            registry_exports(registry, &mut out);
        }
        reject_value_conflicts(&mut out);
        let mut seen = std::collections::HashSet::new();
        out.retain(|(name, _)| seen.insert(name.clone()));
        found.then_some(out)
    }
}

/// Marks ambiguous host authority before exports are deduplicated.
fn reject_value_conflicts(exports: &mut [(String, Made)]) {
    let conflicts: HashSet<_> = exports
        .iter()
        .filter(|(_, made)| matches!(made, Made::Value(_)))
        .filter(|(name, _)| exports.iter().filter(|(other, _)| other == name).count() > 1)
        .map(|(name, _)| name.clone())
        .collect();
    for (name, made) in exports {
        if conflicts.contains(name) {
            *made = Made::DuplicateValue;
        }
    }
}

/// The exports of `registry`: its components, modules, classes and
/// re-exports.
fn registry_exports(registry: &Registry, out: &mut Vec<(String, Made)>) {
    let modules = registry.module_specs();
    let specs = registry.specs();
    for spec in &specs {
        let module = modules.iter().find(|m| m.name == spec.export).cloned();
        out.push((spec.export.clone(), Made::Component(spec.clone(), module)));
    }
    for m in &modules {
        if specs.iter().any(|s| s.export == m.name)
            || (!m.flat && registry.function_members(m.name).is_some())
        {
            continue;
        }
        if m.flat {
            // A getter reads the object's property; it is no export.
            for f in m.functions.iter().filter(|f| !f.getter) {
                let members = registry.function_members(f.name);
                out.push((
                    f.name.to_owned(),
                    Made::Function(m.clone(), f.name, members),
                ));
            }
            for constant in &m.constants {
                out.push((
                    constant.name.to_owned(),
                    Made::Constant(m.clone(), constant.name),
                ));
            }
        } else {
            out.push((m.name.to_owned(), Made::Module(m.clone())));
        }
        if m.default {
            out.push(("default".to_owned(), Made::Default(m.clone())));
        }
    }
    // An interface's objects come from members only: no value.
    for class in registry
        .class_specs()
        .into_iter()
        .filter(|c| !c.def.interface)
    {
        out.push((class.name.to_owned(), Made::Class(class.def)));
    }
    for value in registry.value_specs() {
        out.push((value.name.to_owned(), Made::Value(value.clone())));
    }
    for &value in registry
        .reexports()
        .0
        .iter()
        .chain(registry.native_value_names())
    {
        out.push((value.to_owned(), Made::Reexport(value)));
    }
}

/// The table is owned by State (or the bytecode compiler), and outlives
/// every module load. No JS values are kept in this context-local handle.
#[derive(Clone, Copy, JsLifetime)]
struct ModuleTablePtr(*const ModuleTable);

pub(crate) fn install(cx: &Ctx<'_>, table: *const ModuleTable) {
    assert!(cx.store_userdata(ModuleTablePtr(table)).is_ok());
}

pub(crate) struct Resolver;
impl rquickjs::loader::Resolver for Resolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        if let Some(name) = crate::standard::normalize(name) {
            return Ok(name.to_owned());
        }
        Ok(normalize_chunk(base, name))
    }
}

// Match QuickJS's default normalization: preserve bare names and only
// consume leading ./ and ../ relative to the importing module's directory.
fn normalize_chunk(base: &str, name: &str) -> String {
    if !name.starts_with('.') {
        return name.to_owned();
    }
    let mut directory = base.rsplit_once('/').map_or("", |(dir, _)| dir);
    let mut rest = name;
    loop {
        if let Some(next) = rest.strip_prefix("./") {
            rest = next;
        } else if let Some(next) = rest.strip_prefix("../") {
            let last = directory.rsplit('/').next().unwrap_or("");
            if directory.is_empty() || matches!(last, "." | "..") {
                break;
            }
            directory = directory.rsplit_once('/').map_or("", |(dir, _)| dir);
            rest = next;
        } else {
            break;
        }
    }
    if directory.is_empty() {
        rest.to_owned()
    } else {
        format!("{directory}/{rest}")
    }
}

pub(crate) struct Loader;
impl rquickjs::loader::Loader for Loader {
    fn load<'js>(
        &mut self,
        cx: &Ctx<'js>,
        name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js>> {
        // Framework typed registries own their native exports, including
        // standard names migrated from handwritten adapters. LLRT providers
        // remain on their original ModuleDef path in this same VM.
        let registered = cx
            .userdata::<ModuleTablePtr>()
            // SAFETY: `install`'s owner (the VM state or the bytecode
            // compiler) keeps the table alive while the context loads.
            .is_some_and(|table| unsafe { (&*table.0).exports(name).is_some() });
        if !registered && let Some(name) = crate::standard::normalize(name) {
            return crate::standard::load(cx, name);
        }
        // SAFETY: the thunk uses this live context's registered table and
        // returns exactly the module created by the existing native loader.
        unsafe { Module::from_load_fn(cx.clone(), name, load_native) }
    }
}

/// Resolve an already-canonical native specifier through the same provider
/// selection used by the runtime loader (also used by type discovery).
#[cfg(not(feature = "bytecode-only"))]
pub(crate) fn load_module<'js>(cx: &Ctx<'js>, name: &str) -> rquickjs::Result<Module<'js>> {
    rquickjs::loader::Loader::load(&mut Loader, cx, name, None)
}

unsafe extern "C" fn load_native(
    raw: *mut JsContext,
    name: *const c_char,
) -> *mut qjs::JSModuleDef {
    // SAFETY: called by Module::from_load_fn while its runtime is locked;
    // the temporary Ctx never escapes this callback.
    let cx = unsafe { Ctx::from_raw(std::ptr::NonNull::new_unchecked(raw)) };
    let table = cx.userdata::<ModuleTablePtr>().map(|table| table.0);
    match table {
        // SAFETY: install's owner keeps the table alive through this load.
        Some(table) => unsafe { load(raw, name, table as *mut c_void) },
        None => {
            // SAFETY: throws on the live context of this callback; the
            // message is a literal without format directives.
            unsafe {
                qjs::JS_ThrowInternalError(raw, c"native module table is not installed".as_ptr());
            }
            std::ptr::null_mut()
        }
    }
}

unsafe extern "C" fn load(
    cx: *mut JsContext,
    name: *const c_char,
    opaque: *mut c_void,
) -> *mut qjs::JSModuleDef {
    // SAFETY: QuickJS passes a NUL-terminated module name; the table is the
    // one `install` registered for this context.
    let (cname, table) = unsafe { (CStr::from_ptr(name), &*(opaque as *const ModuleTable)) };
    let exports = cname.to_str().ok().and_then(|n| table.export_names(n));
    // Taken first: compiling it loads its imports, here again.
    let chunk = match (&exports, cname.to_str()) {
        (None, Ok(id)) => table.chunks.borrow_mut().code.remove(id).map(|c| (id, c)),
        _ => None,
    };
    if let Some((id, code)) = chunk {
        // SAFETY: a live context; `code` is trusted as the host's API
        // requires.
        let m = unsafe { compile_chunk(cx, name, code) };
        if !m.is_null() {
            table.chunks.borrow_mut().loaded.insert(id.to_owned());
        }
        return m;
    }
    let Some(exports) = exports else {
        // SAFETY: throws on a live context; `%s` keeps the name literal.
        unsafe {
            qjs::JS_ThrowReferenceError(
                cx,
                c"could not load module '%s' (only registered native modules and bundle chunks can be imported at run time)"
                    .as_ptr(),
                name,
            )
        };
        return std::ptr::null_mut();
    };
    // SAFETY: a new C module declaring its exports (set by `init`).
    unsafe {
        let m = qjs::JS_NewCModule(cx, name, Some(init));
        if m.is_null() {
            return m;
        }
        for export in &exports {
            let export = CString::new(export.as_str()).unwrap_or_default();
            qjs::JS_AddModuleExport(cx, m, export.as_ptr());
        }
        m
    }
}

/// Compiles chunk `name` (its imports resolved by the loader, recursively);
/// null with the exception pending when it does not compile.
///
/// # Safety
///
/// `cx` is live; bytecode is trusted.
unsafe fn compile_chunk(
    cx: *mut JsContext,
    name: *const c_char,
    chunk: ChunkModule,
) -> *mut qjs::JSModuleDef {
    let ChunkModule { code, asset_base } = chunk;
    // SAFETY: per the contract; QuickJS reads source up to the NUL it
    // requires after it.
    let module = unsafe {
        match code {
            ChunkCode::Source(mut source) => {
                let len = source.len();
                source.push('\0');
                qjs::JS_Eval(
                    cx,
                    source.as_ptr() as *const c_char,
                    len as _,
                    name,
                    (qjs::JS_EVAL_TYPE_MODULE | qjs::JS_EVAL_FLAG_COMPILE_ONLY) as c_int,
                )
            }
            ChunkCode::Bytecode(bytes) => qjs::JS_ReadObject(
                cx,
                bytes.as_ptr(),
                bytes.len() as _,
                qjs::JS_READ_OBJ_BYTECODE as c_int,
            ),
        }
    };
    // SAFETY: inspecting and freeing the value just made.
    unsafe {
        if qjs::JS_IsException(module) {
            return std::ptr::null_mut();
        }
        if qjs::JS_VALUE_GET_TAG(module) != qjs::JS_TAG_MODULE {
            qjs::JS_FreeValue(cx, module);
            qjs::JS_ThrowTypeError(cx, c"chunk '%s' is not a module".as_ptr(), name);
            return std::ptr::null_mut();
        }
        let m = qjs::JS_VALUE_GET_PTR(module) as *mut qjs::JSModuleDef;
        if let Some(base) = asset_base {
            let meta = qjs::JS_GetImportMeta(cx, m);
            if qjs::JS_IsException(meta) {
                qjs::JS_FreeValue(cx, module);
                return std::ptr::null_mut();
            }
            let result = crate::web::js::string(cx, &base)
                .and_then(|base| crate::web::js::define(cx, meta, "assetBase", base, true));
            qjs::JS_FreeValue(cx, meta);
            if result.is_err() {
                qjs::JS_FreeValue(cx, module);
                return std::ptr::null_mut();
            }
        }
        // The context keeps the module: the value is one more reference.
        qjs::JS_FreeValue(cx, module);
        m
    }
}

unsafe extern "C" fn init(cx: *mut JsContext, m: *mut qjs::JSModuleDef) -> c_int {
    // SAFETY: the module's name atom, freed below; exports are new values
    // the module takes; the state's table lives as long as the context.
    unsafe {
        let atom = qjs::JS_GetModuleName(cx, m);
        let name = qjs::JS_AtomToCStringLen(cx, std::ptr::null_mut(), atom);
        qjs::JS_FreeAtom(cx, atom);
        if name.is_null() {
            return -1;
        }
        let state = crate::state::state(cx);
        let specifier = CStr::from_ptr(name).to_string_lossy().into_owned();
        qjs::JS_FreeCString(cx, name);
        let Some(exports) = (*state).modules.exports(&specifier) else {
            return -1;
        };
        if let Some(object) = host_module(cx, &specifier) {
            if qjs::JS_IsException(object) {
                return -1;
            }
            qjs::JS_FreeValue(cx, object);
            let canonical = {
                let cached = (*state).modules.materialized.borrow();
                let Some(Materialized::Ready { exports, .. }) = cached.get(&specifier) else {
                    return -1;
                };
                exports.clone()
            };
            // Canonical values stay owned by the cache for the context's life.
            for (export, value) in canonical {
                let cname = CString::new(export.as_str()).unwrap_or_default();
                if qjs::JS_SetModuleExport(cx, m, cname.as_ptr(), qjs::JS_DupValue(cx, value)) != 0
                {
                    return -1;
                }
            }
            return 0;
        }
        // Reject ambiguous authority before constructing any host values.
        if let Some((name, _)) = exports
            .iter()
            .find(|(_, made)| matches!(made, Made::DuplicateValue))
        {
            let name = CString::new(name.as_str()).unwrap_or_default();
            qjs::JS_ThrowTypeError(
                cx,
                c"host export '%s' is registered twice".as_ptr(),
                name.as_ptr(),
            );
            return -1;
        }
        // One object per typed module in the VM: default and flat named
        // exports share its functions and values, as a global made from it
        // does.
        let table = &(*state).modules;
        let default_spec = exports.iter().find_map(|(_, made)| match made {
            Made::Default(spec) if spec.flat => Some(spec.clone()),
            _ => None,
        });
        for (export, made) in exports {
            let value = make(cx, table, &specifier, default_spec.as_ref(), &export, made);
            if qjs::JS_IsException(value) {
                return -1;
            }
            let cname = CString::new(export.as_str()).unwrap_or_default();
            if qjs::JS_SetModuleExport(cx, m, cname.as_ptr(), value) != 0 {
                return -1;
            }
        }
    }
    0
}

/// The value of export `export` of module `name` (owned; an exception when
/// making it threw). A typed module's object is the VM's one (`table`), and
/// a value of a flat default module (`default_spec`) is that object's.
fn make(
    cx: *mut JsContext,
    table: &ModuleTable,
    name: &str,
    default_spec: Option<&Arc<ModuleSpec>>,
    export: &str,
    made: Made,
) -> JsValue {
    let member = |spec: &ModuleSpec, member: &str| {
        let object = crate::web::js::V::own(cx, table.object(cx, name, spec));
        // SAFETY: inline tag check; a property read of the live object.
        unsafe {
            if qjs::JS_IsException(object.raw()) {
                return qjs::JS_EXCEPTION;
            }
            let member = CString::new(member).unwrap_or_default();
            qjs::JS_GetPropertyStr(cx, object.raw(), member.as_ptr())
        }
    };
    match made {
        Made::Own(e) => make_own(cx, export, e),
        Made::Shared(module, e) => table.shared(cx, module, export, e),
        Made::Component(spec, module) => components::component(cx, spec, module),
        Made::Module(spec) | Made::Default(spec) => table.object(cx, name, &spec),
        Made::Function(spec, f, members) if !spec.default => {
            let function = components::module_function(cx, &spec, f);
            if let Some(members) = members {
                components::add_functions(cx, function, &members);
            }
            function
        }
        // The object's function, which has its members already.
        Made::Function(spec, f, _) | Made::Constant(spec, f) => member(&spec, f),
        Made::Class(def) => match crate::classes::constructor(cx, def) {
            Ok(ctor) => ctor.take(),
            Err(_) => qjs::JS_EXCEPTION,
        },
        Made::Value(spec) => {
            let host = crate::classes::host_outside_calls(cx);
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                spec.make()
                    .to_js_value(&host)
                    .map(|v| crate::classes::from_raw(v.into_raw()))
            })) {
                Ok(Ok(value)) => value,
                Ok(Err(error)) => {
                    let message = CString::new(error.to_string()).unwrap_or_default();
                    // SAFETY: the context is live and `%s` keeps the message literal.
                    unsafe { qjs::JS_ThrowTypeError(cx, c"%s".as_ptr(), message.as_ptr()) }
                }
                Err(panic) => {
                    let message =
                        CString::new(crate::classes::panic_message(panic)).unwrap_or_default();
                    // SAFETY: as above.
                    unsafe { qjs::JS_ThrowInternalError(cx, c"%s".as_ptr(), message.as_ptr()) }
                }
            }
        }
        Made::DuplicateValue => {
            let name = CString::new(export).unwrap_or_default();
            // SAFETY: the context is live and `%s` keeps the name literal.
            unsafe {
                qjs::JS_ThrowTypeError(
                    cx,
                    c"host export '%s' is registered twice".as_ptr(),
                    name.as_ptr(),
                )
            }
        }
        Made::Reexport(value) => match default_spec {
            Some(spec) => member(spec, value),
            None => env::reexport(cx, value),
        },
    }
}

/// The value of nsh's own export `export` (owned).
fn make_own(cx: *mut JsContext, export: &str, e: Export) -> JsValue {
    match e {
        Export::Function(f, length) => {
            let cname = CString::new(export).unwrap_or_default();
            reactive::new_function(cx, &cname, f, length)
        }
        Export::Value(make) => make(cx),
    }
}

/// The exports of the UI set the host registered under `specifier`, as one
/// object (`nativeModule`; owned): `None` when the host registered none,
/// an exception when making an export threw.
pub(crate) fn host_module(cx: *mut JsContext, specifier: &str) -> Option<JsValue> {
    // SAFETY: the context owns the table for its entire lifetime.
    let table = unsafe { &(*crate::state::state(cx)).modules };
    let cached = table.materialized.borrow().get(specifier).map(|module| {
        // SAFETY: duplicating does not run JS; the cache owns each value.
        unsafe {
            match module {
                Materialized::Ready { object, .. } => (Some(qjs::JS_DupValue(cx, *object)), None),
                Materialized::Failed(error) => (None, Some(qjs::JS_DupValue(cx, *error))),
                Materialized::Initializing => (None, None),
            }
        }
    });
    if let Some((value, error)) = cached {
        // SAFETY: exceptions consume owned duplicates, after the cache borrow ends.
        return Some(unsafe {
            match (value, error) {
                (Some(value), _) => value,
                (_, Some(error)) => qjs::JS_Throw(cx, error),
                _ => qjs::JS_ThrowTypeError(cx, c"host module is already initializing".as_ptr()),
            }
        });
    }
    let public_names: HashSet<_> = table
        .host_exports(specifier)?
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let exports = table.exports(specifier)?;
    table
        .materialized
        .borrow_mut()
        .insert(specifier.to_owned(), Materialized::Initializing);
    // No cache borrow is held while factories or conversions execute.
    let materialized = materialize(cx, table, specifier, exports, &public_names);
    let value = match &materialized {
        // SAFETY: new owned values are retained in the cache below.
        Materialized::Ready { object, .. } => unsafe { qjs::JS_DupValue(cx, *object) },
        // SAFETY: as above; throwing transfers the duplicate to QuickJS.
        Materialized::Failed(error) => unsafe { qjs::JS_Throw(cx, qjs::JS_DupValue(cx, *error)) },
        Materialized::Initializing => unreachable!(),
    };
    table
        .materialized
        .borrow_mut()
        .insert(specifier.to_owned(), materialized);
    Some(value)
}

/// Constructs the whole module or retains its first error, before exposing it.
fn materialize(
    cx: *mut JsContext,
    table: &ModuleTable,
    specifier: &str,
    exports: Vec<(String, Made)>,
    public_names: &HashSet<String>,
) -> Materialized {
    let default_spec = exports.iter().find_map(|(_, made)| match made {
        Made::Default(spec) if spec.flat => Some(spec.clone()),
        _ => None,
    });
    // SAFETY: the context is live; every new value is transferred or freed.
    unsafe {
        if let Some((export, _)) = exports
            .iter()
            .find(|(_, made)| matches!(made, Made::DuplicateValue))
        {
            let name = CString::new(export.as_str()).unwrap_or_default();
            qjs::JS_ThrowTypeError(
                cx,
                c"host export '%s' is registered twice".as_ptr(),
                name.as_ptr(),
            );
            return Materialized::Failed(qjs::JS_GetException(cx));
        }
        let object = qjs::JS_NewObject(cx);
        if qjs::JS_IsException(object) {
            return Materialized::Failed(qjs::JS_GetException(cx));
        }
        let mut canonical = Vec::new();
        for (export, made) in exports {
            let value = make(cx, table, specifier, default_spec.as_ref(), &export, made);
            if !qjs::JS_IsException(value) {
                let name = CString::new(export.as_str()).unwrap_or_default();
                if !public_names.contains(&export)
                    || qjs::JS_DefinePropertyValueStr(
                        cx,
                        object,
                        name.as_ptr(),
                        qjs::JS_DupValue(cx, value),
                        qjs::JS_PROP_C_W_E as i32,
                    ) >= 0
                {
                    canonical.push((export, value));
                    continue;
                }
                qjs::JS_FreeValue(cx, value);
            }
            let error = qjs::JS_GetException(cx);
            for (_, value) in canonical {
                qjs::JS_FreeValue(cx, value);
            }
            qjs::JS_FreeValue(cx, object);
            return Materialized::Failed(error);
        }
        Materialized::Ready {
            exports: canonical,
            object,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use nsh_core::element::{JsHost, JsOwned, PropError, Registry, Ret, TsTypes};

    use crate::{Host, HostOptions};

    #[test]
    fn host_values_are_lazy_once_per_vm_and_absent_from_other_vms() {
        let calls = Arc::new(AtomicUsize::new(0));
        let called = calls.clone();
        let mut registry = Registry::ui_set("test/host");
        registry.value("identity", move || {
            called.fetch_add(1, Ordering::SeqCst) as u32
        });
        let source = "import { identity } from 'test/host'; if (identity !== EXPECTED) throw Error('wrong owner');";
        let bytecode = crate::compile_bytecode_with(
            &source.replace("EXPECTED", "0"),
            false,
            &[(&registry).into()],
        )
        .unwrap();
        let declarations = crate::type_definitions(&[(&registry).into()]);
        assert!(declarations.iter().any(|(path, body)| {
            path == "test/host.d.ts" && body.contains("export declare const identity: number;")
        }));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "tooling cannot acquire host capabilities"
        );

        let host = Host::with_options(HostOptions {
            ui_sets: vec![registry.clone()],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0, "VM creation is not import");
        host.eval_bytecode(&bytecode).unwrap();
        host.eval_source(&source.replace("EXPECTED", "0")).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let other = Host::with_options(HostOptions {
            ui_sets: vec![registry],
            ..Default::default()
        })
        .unwrap();
        other.eval_source(&source.replace("EXPECTED", "1")).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[nsh_core::element::class]
    struct BoundHost {
        identity: u32,
    }

    #[nsh_core::element::class]
    impl BoundHost {
        pub(crate) fn identity(&self) -> u32 {
            self.identity
        }
    }

    #[test]
    fn native_module_and_import_share_canonical_values_in_both_orders() {
        for native_first in [false, true] {
            let calls = Arc::new(AtomicUsize::new(0));
            let called = calls.clone();
            let mut registry = Registry::ui_set("test/host");
            registry.value("host", move || {
                nsh_core::element::Instance::new(BoundHost {
                    identity: called.fetch_add(1, Ordering::SeqCst) as u32,
                })
            });
            let host = Host::with_options(HostOptions {
                ui_sets: vec![registry],
                ..Default::default()
            })
            .unwrap();
            let access = r#"
                import { nativeModule } from 'nsh';
                const module = nativeModule('test/host');
                globalThis.original = module.host;
                globalThis.constructor = module.BoundHost;
                if (module !== nativeModule('test/host')) throw Error('uncached facade');
                Object.defineProperty(module, 'host', { get() { throw Error('replaced facade'); } });
            "#;
            if native_first {
                host.eval_source(access).unwrap();
            } else {
                host.eval_source("import { host } from 'test/host'; if (host.identity() !== 0) throw Error('wrong owner');").unwrap();
                host.eval_source(access).unwrap();
            }
            host.eval_source(r#"
                import { host, BoundHost } from 'test/host';
                if (host !== globalThis.original || host.identity() !== 0 || BoundHost !== globalThis.constructor)
                    throw Error('import did not retain canonical values');
            "#).unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn host_exports_can_extend_a_runtime_registry_without_hiding_its_exports() {
        // A canonical import is not host authority by itself.
        let error = Host::new()
            .unwrap()
            .eval_source("import { nativeModule } from 'nsh'; nativeModule('nsh');")
            .unwrap_err();
        assert!(error.message.contains("nothing is registered"), "{error}");

        let mut registry = Registry::ui_set("nsh");
        registry.value("extra", || 42u32);
        let host = Host::with_options(HostOptions {
            ui_sets: vec![registry],
            ..Default::default()
        })
        .unwrap();
        host.eval_source(
            r#"
            import { nativeModule } from 'nsh';
            const host = nativeModule('nsh');
            if (host.extra !== 42 || 'Clipboard' in host) throw Error('wrong host facade');
        "#,
        )
        .unwrap();
        host.eval_source(r#"
            import { Clipboard, extra } from 'nsh';
            if (typeof Clipboard.readText !== 'function' || extra !== 42) throw Error('runtime export hidden');
        "#).unwrap();

        let mut registry = Registry::ui_set("process");
        registry.value("extra", || 42u32);
        let host = Host::with_options(HostOptions {
            ui_sets: vec![registry],
            ..Default::default()
        })
        .unwrap();
        host.eval_source(
            r#"
            import process, { extra, nextTick } from 'process';
            import { nativeModule } from 'nsh';
            const host = nativeModule('process');
            if (host.extra !== 42 || extra !== 42 || 'default' in host || 'nextTick' in host)
                throw Error('wrong host facade');
            if (process !== globalThis.process || process.nextTick !== nextTick)
                throw Error('runtime module identity changed');
        "#,
        )
        .unwrap();

        let mut registry = Registry::ui_set("nsh");
        registry.value("Clipboard", || -> u32 {
            panic!("ambiguous factory must not execute")
        });
        let host = Host::with_options(HostOptions {
            ui_sets: vec![registry],
            ..Default::default()
        })
        .unwrap();
        let error = host
            .eval_source("import { nativeModule } from 'nsh'; nativeModule('nsh');")
            .unwrap_err();
        assert!(
            error
                .message
                .contains("host export 'Clipboard' is registered twice"),
            "{error}"
        );
    }

    struct Invalid;

    impl Ret for Invalid {
        fn ts_type(_: &mut TsTypes) -> String {
            "never".into()
        }
        fn into_js<'a>(self, _: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
            Err(PropError("invalid host value".into()))
        }
    }

    #[test]
    fn host_value_failures_are_module_errors() {
        for panic in [false, true] {
            let mut registry = Registry::ui_set("test/bad-host");
            registry.value("host", move || {
                assert!(!panic, "host factory failed");
                Invalid
            });
            let host = Host::with_options(HostOptions {
                ui_sets: vec![registry],
                ..Default::default()
            })
            .unwrap();
            let error = host
                .eval_source("import { host } from 'test/bad-host';")
                .unwrap_err();
            assert!(
                error.message.contains(if panic {
                    "host factory failed"
                } else {
                    "invalid host value"
                }),
                "{error}"
            );
        }
    }

    #[test]
    fn failed_host_module_materialization_is_not_retried_in_the_vm() {
        let calls = Arc::new(AtomicUsize::new(0));
        let called = calls.clone();
        let mut registry = Registry::ui_set("test/bad-host");
        registry.value("host", move || {
            called.fetch_add(1, Ordering::SeqCst);
            Invalid
        });
        let host = Host::with_options(HostOptions {
            ui_sets: vec![registry],
            ..Default::default()
        })
        .unwrap();
        for _ in 0..2 {
            let error = host
                .eval_source("import { nativeModule } from 'nsh'; nativeModule('test/bad-host');")
                .unwrap_err();
            assert!(error.message.contains("invalid host value"), "{error}");
        }
        let error = host
            .eval_source("import { host } from 'test/bad-host';")
            .unwrap_err();
        assert!(error.message.contains("invalid host value"), "{error}");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn conflicting_host_registries_do_not_choose_a_factory() {
        let mut first = Registry::ui_set("test/host");
        first.value("unrelated", || -> u32 {
            panic!("module must not acquire host values")
        });
        first.value("host", || -> u32 { panic!("first factory must not run") });
        let mut second = Registry::ui_set("test/host");
        second.value("host", || -> u32 { panic!("second factory must not run") });
        let host = Host::with_options(HostOptions {
            ui_sets: vec![first, second],
            ..Default::default()
        })
        .unwrap();
        let error = host
            .eval_source("import { host } from 'test/host';")
            .unwrap_err();
        assert!(
            error
                .message
                .contains("host export 'host' is registered twice"),
            "{error}"
        );
    }

    #[test]
    fn nshs_own_modules_are_the_ones_the_bundler_knows() {
        let names: Vec<&str> = super::MODULES
            .iter()
            .filter(|m| m.moved_to.is_none())
            .map(|m| m.name)
            .collect();
        assert_eq!(names, nsh_core::js::NATIVE_MODULES);
    }

    /// `Image` carries its functions; the areas the primitives come from
    /// are no modules of their own.
    #[test]
    fn nsh_serves_the_primitives() {
        let source = r#"
            import * as nsh from "nsh";
            if (typeof nsh.Image.getSize !== "function" || typeof nsh.Image.prefetch !== "function") {
                throw Error("Image carries its functions");
            }
            if (!(new nsh.Path2D("M0 0 L1 1") instanceof nsh.Path2D)) throw Error("Path2D");
        "#;
        crate::Host::new().unwrap().eval_source(source).unwrap();
        for old in [
            "nsh/image",
            "nsh/list",
            "nsh/canvas",
            "nsh/webview",
            "nsh/video",
        ] {
            let source = format!("import * as old from \"{old}\";");
            assert!(
                crate::Host::new().unwrap().eval_source(&source).is_err(),
                "{old}"
            );
        }
    }

    /// The bytecode compiler, which knows a UI set by its description,
    /// links against the names a VM serving the set exports.
    #[test]
    fn a_described_set_exports_what_its_registry_does() {
        for registry in [nsh_base::registry(), crate::classes::tests::registry()] {
            let specifier = registry.specifier().unwrap();
            let served = super::ModuleTable::new(std::slice::from_ref(&registry));
            let compiled = super::ModuleTable::compiling(&[(&registry).into()]);
            let mut served: Vec<String> = served
                .exports(specifier)
                .unwrap()
                .into_iter()
                .map(|(name, _)| name)
                .collect();
            let mut compiled = compiled.export_names(specifier).unwrap();
            assert!(!served.is_empty(), "{specifier}");
            served.sort();
            compiled.sort();
            assert_eq!(compiled, served, "{specifier}");
        }
        let compiling = super::ModuleTable::compiling(&[]);
        assert!(compiling.export_names("nsh/base").is_none());
        assert!(compiling.export_names("nsh").is_some());
    }
}

#[cfg(test)]
mod loader_tests {
    use super::normalize_chunk;

    #[test]
    fn typed_os_uses_one_object_in_source_bytecode_and_generated_types() {
        let source = r#"
            import os, {EOL,platform,arch,homedir} from 'os';
            import {Buffer} from 'buffer';
            import {Text} from 'nsh';
            if (Object.keys(os).sort().join(',') !== 'EOL,arch,homedir,platform') throw Error('shape');
            if (os.platform !== platform || os.arch !== arch || os.homedir !== homedir || os.EOL !== EOL) throw Error('identity');
            if (typeof platform() !== 'string' || typeof arch() !== 'string') throw Error('sync result');
            if (Buffer.from('os').toString() !== 'os' || typeof Text !== 'function') throw Error('mixed provider');
        "#;
        crate::Host::new().unwrap().eval_source(source).unwrap();
        let bytecode = crate::compile_bytecode(source, false).unwrap();
        crate::Host::new()
            .unwrap()
            .eval_bytecode(&bytecode)
            .unwrap();
        let declarations = crate::type_definitions(&[]);
        let (_, generated) = declarations
            .iter()
            .find(|(path, _)| path == "os.d.ts")
            .expect("registry declaration file");
        assert!(generated.contains("export declare function platform(): string;"));
        assert!(generated.contains("export declare const EOL: string;"));
        assert!(generated.contains("export default defaultExport;"));
        assert!(generated.contains("readonly EOL: string;"));
    }

    #[test]
    fn relative_chunks_keep_quickjs_default_resolution() {
        assert_eq!(normalize_chunk("bundle.js", "./chunk.js"), "chunk.js");
        assert_eq!(normalize_chunk("a/b/main.js", "../chunk.js"), "a/chunk.js");
        assert_eq!(
            normalize_chunk("a/main.js", "../../chunk.js"),
            "../chunk.js"
        );
        assert_eq!(normalize_chunk("a/main.js", "nsh/device"), "nsh/device");
        assert_eq!(
            normalize_chunk("a/main.js", "./x/../chunk.js"),
            "a/x/../chunk.js"
        );
    }
}
