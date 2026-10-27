//! Components: the [`Component`] trait, its [`Props`] and [`Event`]s
//! (derived), the [`Registry`] a surface renders from, and the JS glue and
//! TypeScript declarations generated from them ([`declarations`]).

use std::{
    any::{Any, TypeId},
    fmt,
    sync::Arc,
};

use rustc_hash::FxHashMap;

use super::{
    Children, IntoElement, PropError, Slot, TsType, TsTypes,
    builder::{ComponentElement, ElNode},
    call::{AnyValue, JsResult, MethodCall, ToJs},
    class::{Class, ClassDef, ClassSpec, MemberKind, Ret, Thrown},
    js::{JsHost, JsIn, JsOwned},
    module::{FunctionSpec, Module, ModuleSpec},
};

/// A component written in Rust: a function that runs once ([`Self::view`])
/// and makes its view, binding what changes to signals. Its props come from
/// JS (or from the component whose view has it), its events go to JS.
/// `#[component]` on a function makes the type and this impl.
///
/// It is registered under its type's full path ([`std::any::type_name`]:
/// its crate, modules and name) and exported to JS as the type's own name
/// (the last segment), so neither is written by hand
/// ([`Registry::register`]).
///
/// ```ignore
/// #[component]
/// pub fn Button(props: ButtonProps, cx: Scope<ButtonEvent>) -> impl IntoElement {
///     view()
///         .px_4()
///         .py_3()
///         .bg(move || theme().primary) // nsh-base's theme
///         .on_press(move || cx.emit(ButtonEvent::Press))
///         .child(text(props.title))
/// }
/// ```
pub trait Component: 'static {
    /// Its props (`#[derive(Props)]`).
    type Props: Props;

    /// Its events (`#[derive(Event)]`; [`NoEvent`] for none).
    type Event: Event;

    /// The methods of its ref in JS: those of the [`Api`] its view
    /// registers (`Methods::of::<StepperApi>()`; none by default).
    const METHODS: Methods = Methods::NONE;

    /// Its documentation in TypeScript: the `#[component]` function's doc
    /// comment (none by default).
    const DOC: &'static str = "";

    /// What it shows: its elements, with bindings where values change (TS:
    /// a component's body). Runs once, under an owner of its own: what it
    /// makes (signals, effects, timers) goes with the component.
    fn view(props: Self::Props, cx: super::Scope<Self::Event>) -> impl IntoElement;

    /// This component inside another one's view, given all its props.
    /// A `#[component]` has a constructor of its own, which Rust views use
    /// (`button().disabled(..)`); this stays for components implemented
    /// by hand and for code generic over components.
    fn element(props: Self::Props) -> ComponentElement<Self>
    where
        Self: Sized,
    {
        ComponentElement::new(props)
    }
}

/// A component's code panicked: what an error boundary
/// ([`super::catch_error`]) shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentError {
    /// The component that failed (its registered name: its type's).
    pub component: &'static str,
    /// What its code panicked with.
    pub message: String,
}

impl fmt::Display for ComponentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} failed: {}", self.component, self.message)
    }
}

/// Runs component code, catching a panic as its message.
pub(crate) fn caught<R>(f: impl FnOnce() -> R) -> Result<R, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).map_err(panic_message)
}

/// The message of a panic's payload.
pub(crate) fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(s) => *s,
        Err(payload) => match payload.downcast::<&'static str>() {
            Ok(s) => (*s).to_owned(),
            Err(_) => "a panic".to_owned(),
        },
    }
}

/// A method JS calls on a component's ref: one of its API's
/// ([`Api`]; `#[methods]` makes them).
pub struct Method {
    /// Its JS name (`setValue`).
    pub name: &'static str,
    /// Documentation.
    pub doc: &'static str,
    /// Its parameters: JS names and TypeScript types.
    pub params: &'static [Param],
    /// The TypeScript type of its result (`None`: it returns nothing, and
    /// JS gets `undefined`: the call runs in order with the props set
    /// before it, with nothing to wait for).
    pub returns: Option<TsType>,
    /// The classes its parameters and result name.
    pub refs: super::ClassRefs,
    /// Its call, the arguments converted in the JS call: what the core
    /// runs with the API, in order with the props set before it. A wrong
    /// argument's error starts with the method's name; the host puts its
    /// component's before it (`Stepper.setValue: ...`).
    pub call: fn(&dyn JsHost) -> Result<MethodCall, Thrown>,
}

/// What a component's ref does in JS: a handle its view makes, holding the
/// signals its methods read and write, registered with
/// [`super::Scope::methods`]. `#[methods]` on its `impl` block implements
/// it.
pub trait Api: Sized + 'static {
    /// Its methods.
    const METHODS: &'static [Method];
}

/// The methods a component's ref has, for its spec and declarations:
/// [`Methods::of`] its [`Api`] (`#[component(methods = StepperApi)]`).
#[derive(Clone, Copy)]
pub struct Methods {
    specs: fn(&mut TsTypes) -> Vec<MethodSpec>,
    refs: super::ClassRefs,
}

impl Methods {
    /// None.
    pub const NONE: Self = Self {
        specs: |_| Vec::new(),
        refs: |_| {},
    };

    /// Those of `A`.
    pub const fn of<A: Api>() -> Self {
        Self {
            specs: specs_of::<A>,
            refs: |out| {
                for m in A::METHODS {
                    (m.refs)(out);
                }
            },
        }
    }
}

fn specs_of<A: Api>(types: &mut TsTypes) -> Vec<MethodSpec> {
    A::METHODS
        .iter()
        .map(|m| MethodSpec {
            name: m.name,
            doc: m.doc,
            params: m
                .params
                .iter()
                .map(|(n, ts, optional)| (*n, ts(types), *optional))
                .collect(),
            returns: m.returns.map(|ts| ts(types)),
            call: m.call,
        })
        .collect()
}

/// A method's parameter: its JS name, its TypeScript type, and whether JS
/// may leave it out (an `Option` after which every parameter is optional).
pub type Param = (&'static str, TsType, bool);

/// One method, for the glue and its declarations.
#[derive(Debug, Clone)]
pub struct MethodSpec {
    /// Its JS name.
    pub name: &'static str,
    /// Documentation.
    pub doc: &'static str,
    /// Its parameters: JS names, TypeScript types, and whether each is
    /// optional.
    pub params: Vec<(&'static str, String, bool)>,
    /// The TypeScript type of its result; `None`: nothing (`void`).
    pub returns: Option<String>,
    /// Its call (the arguments converted in the JS call).
    pub call: fn(&dyn JsHost) -> Result<MethodCall, Thrown>,
}

impl MethodSpec {
    /// Whether JS gets a `Promise` of the result: when the method returns
    /// a value (`Result<(), E>` too, rejected with an `Err`). One
    /// returning `()` gives `undefined` (`void`): the call runs in order
    /// with the UI and nothing answers it, and a wrong argument throws.
    pub fn promises(&self) -> bool {
        self.returns.is_some()
    }
}

/// What a prop is to the glue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropKind {
    /// A value: decoded in the JS call ([`PropSpec::decode`]), set by the
    /// core.
    Value,
    /// A render function (`Option<Renderer<T>>`): decoded in the JS call
    /// as a value is (a function, or none), its content rendered by JS
    /// when the core asks for it ([`super::JsEvent::Render`]).
    Renderer,
    /// A named slot: JSX in a holder node.
    Slot,
    /// The JSX children.
    Children,
    /// Virtualized rows: in JS `each`, a row renderer and the data props of
    /// `List` (the glue makes the list, the component places it).
    Items,
}

/// What converts a JS value into a prop's Rust type (the prop's
/// [`super::JsValue::from_js`], type-erased): `nsh-js` calls it when JS
/// sets the prop.
pub type PropDecode = fn(JsIn<'_>) -> Result<AnyValue, PropError>;

/// One prop, for the glue and its declarations.
#[derive(Debug, Clone)]
pub struct PropSpec {
    /// Its JS name (`accessibilityLabel`).
    pub name: &'static str,
    /// Its TypeScript type.
    pub ts: String,
    /// It may be left out.
    pub optional: bool,
    /// Documentation.
    pub doc: &'static str,
    /// What it is.
    pub kind: PropKind,
    /// A value prop's value from JS (`None` for slots, children and rows).
    pub decode: Option<PropDecode>,
}

/// One event, for the glue and its declarations.
#[derive(Debug, Clone)]
pub struct EventSpec {
    /// Its name (`press`: the handler is `onPress`).
    pub name: &'static str,
    /// The name of the handler's argument in TypeScript (`value`, or what
    /// `#[args(..)]` on the variant says; unused without data).
    pub arg: &'static str,
    /// The TypeScript type of its data (`void` for none).
    pub data: String,
    /// Documentation.
    pub doc: &'static str,
    /// The handler takes several arguments (`#[args(open, reason)]` on a
    /// variant of as many fields): `data` is their list (`open: boolean,
    /// reason: …`), the data a JS array of them.
    pub spread: bool,
}

/// A component's props. Derive it: `#[derive(Props)]`.
pub trait Props: Clone + PartialEq + 'static {
    /// The JS name of the [`super::Items`] prop, if it has one.
    #[doc(hidden)]
    const ITEMS: Option<&'static str> = None;

    /// Its children are made only while the view places them
    /// (`#[prop(lazy)]`).
    #[doc(hidden)]
    const LAZY_CHILDREN: bool = false;

    /// TS declares the props generic over `T`, the type of the rows a prop
    /// takes (`#[props(generic)]`; a prop's type names it, as
    /// [`super::Rows`] does).
    #[doc(hidden)]
    const GENERIC: bool = false;

    /// The props (their named types declared in `types`).
    fn spec(types: &mut TsTypes) -> Vec<PropSpec>;

    /// Every prop at its default.
    fn initial() -> Self;

    /// Prop `name` (its JS name) from JS, as [`PropSpec::decode`] made it;
    /// `None` restores its default. Returns whether it changed.
    fn set(&mut self, name: &str, value: Option<AnyValue>) -> Result<bool, PropError>;

    /// Slot `name` filled (`Some`) or not; returns whether it changed.
    fn set_slot(&mut self, name: &str, slot: Option<Slot>) -> bool;

    /// Whether the app passed children; returns whether it changed.
    fn set_children(&mut self, children: Children) -> bool;

    /// The props an instance keeps: each [`super::Prop`] field held in a
    /// signal of the current owner, so new values reach only what read it.
    #[doc(hidden)]
    fn held(&self) -> Self {
        self.clone()
    }

    /// An instance's props take `new`'s (a parent's region made the
    /// element again): held props update their readers; returns whether
    /// another field changed.
    #[doc(hidden)]
    fn update_from(&mut self, new: &Self) -> bool {
        if self == new {
            return false;
        }
        *self = new.clone();
        true
    }
}

/// The props of a component that has none (an app's root, say).
impl Props for () {
    fn spec(_: &mut TsTypes) -> Vec<PropSpec> {
        Vec::new()
    }

    fn initial() -> Self {}

    fn set(&mut self, name: &str, _: Option<AnyValue>) -> Result<bool, PropError> {
        Err(PropError(format!("unknown prop `{name}`")))
    }

    fn set_slot(&mut self, _: &str, _: Option<Slot>) -> bool {
        false
    }

    fn set_children(&mut self, _: Children) -> bool {
        false
    }
}

/// A component's events. Derive it: `#[derive(Event)]`. The element of a
/// `#[component]` emitting them gets a listener method per event, named
/// as its TSX handler in snake case (`onPress` is `.on_press(..)`): a
/// unit variant's takes `move || ..`, a one-field variant's the value
/// (`move |index: &u32| ..`), a named-field variant's the event itself
/// ([`ComponentBuilder`](super::ComponentBuilder)).
pub trait Event: 'static {
    /// The events (their named types declared in `types`).
    fn spec(types: &mut TsTypes) -> Vec<EventSpec>;

    /// This event's name.
    fn name(&self) -> &'static str;

    /// Its data as a JS value of `host` (converted when JS hears it).
    fn data_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError>;

    /// The handler takes the items of the data (an array) as its
    /// arguments ([`EventSpec::spread`]).
    fn spread(&self) -> bool {
        false
    }
}

/// The events of a component that has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoEvent {}

impl Event for NoEvent {
    fn spec(_types: &mut TsTypes) -> Vec<EventSpec> {
        Vec::new()
    }

    fn name(&self) -> &'static str {
        match *self {}
    }

    fn data_js<'a>(&self, _host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match *self {}
    }
}

/// What a component is to JS: its glue and declarations are generated
/// from it ([`declarations`]).
#[derive(Debug, Clone)]
pub struct ComponentSpec {
    /// Its registered name: its type's full path ([`std::any::type_name`]),
    /// unique within one binary.
    pub name: &'static str,
    /// Its JS export: the type's own name, the last segment of its path.
    pub export: String,
    /// Documentation.
    pub doc: &'static str,
    /// Its props, slots and children.
    pub props: Vec<PropSpec>,
    /// Its events.
    pub events: Vec<EventSpec>,
    /// The methods of its ref.
    pub methods: Vec<MethodSpec>,
    /// The named TypeScript types they use.
    pub types: TsTypes,
    /// JS makes the children only while the view places them
    /// (`#[prop(lazy)]` on its `Children`): the core tells it with a
    /// `$children` event on the host.
    pub lazy_children: bool,
    /// Its props are generic over `T`, the type of the rows one takes
    /// (`#[props(generic)]`), as a component with [`super::Items`] is.
    pub generic: bool,
}

impl ComponentSpec {
    pub(crate) fn of<C: Component>() -> Self {
        let mut types = TsTypes::default();
        let props = C::Props::spec(&mut types);
        let events = C::Event::spec(&mut types);
        let methods = (C::METHODS.specs)(&mut types);
        let name = name_of::<C>();
        Self {
            name,
            export: export_name(name).to_owned(),
            doc: C::DOC,
            props,
            events,
            methods,
            types,
            lazy_children: C::Props::LAZY_CHILDREN,
            generic: C::Props::GENERIC,
        }
    }

    /// Its named slots.
    pub fn slots(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.props
            .iter()
            .filter(|p| p.kind == PropKind::Slot)
            .map(|p| p.name)
    }

    /// Its render functions ([`PropKind::Renderer`]).
    pub fn renderers(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.props
            .iter()
            .filter(|p| p.kind == PropKind::Renderer)
            .map(|p| p.name)
    }

    /// Whether it takes JSX children.
    pub fn takes_children(&self) -> bool {
        self.props.iter().any(|p| p.kind == PropKind::Children)
    }

    /// Its [`PropKind::Items`] prop (one at most).
    pub fn items(&self) -> Option<&'static str> {
        self.props
            .iter()
            .find(|p| p.kind == PropKind::Items)
            .map(|p| p.name)
    }

    /// The nodes the glue makes for it, by name: slots and the list.
    pub(crate) fn holder(&self, name: &str) -> Option<&'static str> {
        self.props
            .iter()
            .find(|p| matches!(p.kind, PropKind::Slot | PropKind::Items) && p.name == name)
            .map(|p| p.name)
    }
}

/// The registered name of component `C`: its type's. It is only compared
/// within one binary, so the format of [`std::any::type_name`] may change
/// between compilers; the exports, which JS sees, are pinned by tests.
pub(crate) fn name_of<C: Component>() -> &'static str {
    std::any::type_name::<C>()
}

/// A type's own name, its JS export: the last segment of its path, without
/// a generic type's arguments (the test `components_are_named_after_their_types`).
fn export_name(type_name: &str) -> &str {
    let path = type_name.split('<').next().unwrap_or(type_name);
    path.rsplit("::").next().unwrap_or(path)
}

/// An instance: a component's props and view, their types erased.
pub(crate) trait AnyInstance {
    fn set_prop(&mut self, name: &str, value: Option<AnyValue>) -> Result<bool, PropError>;
    /// Props from the component whose view has this one.
    fn set_props(&mut self, props: &dyn Any);
    fn set_slot(&mut self, name: &'static str, filled: bool);
    fn set_children(&mut self, present: bool);
    /// The component goes away: what its view made goes with it.
    fn cleanup(&mut self);
    /// Its view, made once.
    fn view(&mut self) -> ElNode;
    /// Its registered name.
    fn name(&self) -> &'static str;
    /// A method of its ref (its arguments decoded); `None` when it has no
    /// ref of the method's type.
    fn call(&mut self, call: MethodCall) -> Option<JsResult>;
    /// Its view's owner, once its view is made.
    fn owner(&self) -> Option<super::Owner>;
    /// Where a failure of its code goes first: its owner, or where it is
    /// made before it has one.
    fn failure_owner(&self) -> super::Owner;
    /// Made by JS (where no owner is): its view will be made under
    /// `parent`, the owner of the nearest component above it in the tree,
    /// so it sees that one's context.
    fn adopt(&mut self, parent: super::Owner);
    /// It is the component of `host`, made where `parent` owns.
    fn place(&mut self, host: crate::NodeId, parent: super::Owner);
}

/// The root of a Rust app: makes the app's top component (on the engine
/// thread, where elements live). The engine mounts it as the content of the
/// surface (`nsh_engine::App::Rust`).
#[derive(Clone)]
pub struct Root {
    make: Arc<dyn Fn() -> super::AnyElement + Send + Sync>,
    tokens: Option<Arc<super::Tokens>>,
    fonts: Vec<Arc<[u8]>>,
    appearance: Option<crate::platform::Appearance>,
    app_id: Option<String>,
    status_bar: Option<crate::StatusBarSetting>,
}

impl Root {
    /// Component `C` with the props `props` makes.
    pub fn new<C: Component>(props: impl Fn() -> C::Props + Send + Sync + 'static) -> Self {
        Self {
            make: Arc::new(move || super::IntoElement::into_element(C::element(props()))),
            tokens: None,
            fonts: Vec::new(),
            appearance: None,
            app_id: None,
            status_bar: None,
        }
    }

    /// The app's id (`nsh.json` `"id"`, which nsh's generated code sets):
    /// it names where the app keeps its data (`nsh/storage`).
    pub fn app_id(mut self, id: impl Into<String>) -> Self {
        self.app_id = Some(id.into());
        self
    }

    /// The app's id ([`Root::app_id`]).
    pub fn app_id_ref(&self) -> Option<&str> {
        self.app_id.as_deref()
    }

    /// Renders with design tokens `tokens` (`nsh-base`'s theme's; by
    /// default the UI sets' defaults).
    pub fn tokens(mut self, tokens: super::Tokens) -> Self {
        self.tokens = Some(Arc::new(tokens));
        self
    }

    /// Registers a font file (TrueType / OpenType) before the first render;
    /// styles name it by its family name.
    pub fn font(mut self, data: impl Into<Arc<[u8]>>) -> Self {
        self.fonts.push(data.into());
        self
    }

    /// Shows the app in `appearance` whatever the system's (`nsh.json`
    /// `"appearance"`; later [`super::ambient::set_color_scheme`] calls
    /// change it).
    pub fn appearance(mut self, appearance: crate::platform::Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }

    /// The status bar's default (`nsh.json` `"statusBar"`), under what
    /// pages and dialogs set (`Screen::status_bar`, `Modal::status_bar`).
    pub fn status_bar(mut self, setting: crate::StatusBarSetting) -> Self {
        self.status_bar = Some(setting);
        self
    }

    /// The status bar's default ([`Root::status_bar`]).
    pub fn status_bar_ref(&self) -> Option<crate::StatusBarSetting> {
        self.status_bar
    }

    /// The appearance it starts in ([`Root::appearance`]; `None`: the
    /// system's).
    pub fn appearance_ref(&self) -> Option<crate::platform::Appearance> {
        self.appearance
    }

    /// The design tokens it renders with.
    pub fn tokens_ref(&self) -> Option<&super::Tokens> {
        self.tokens.as_deref()
    }

    /// The font files to register.
    pub fn fonts(&self) -> &[Arc<[u8]>] {
        &self.fonts
    }

    /// Component `C` with default props.
    pub fn of<C: Component>() -> Self
    where
        C::Props: Default,
    {
        Self::new::<C>(C::Props::default)
    }

    /// The element of the root component.
    pub(crate) fn element(&self) -> super::AnyElement {
        (self.make)()
    }
}

impl fmt::Debug for Root {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Root")
    }
}

/// A new instance of `C`, its props not set yet.
pub(crate) fn make_instance<C: Component>() -> Box<dyn AnyInstance> {
    Box::new(super::once::OnceInstance::<C>::new())
}

#[derive(Clone)]
struct ComponentType {
    spec: Arc<ComponentSpec>,
    make: fn() -> Box<dyn AnyInstance>,
    /// Tells two types of the same name apart (two versions of a crate).
    id: TypeId,
}

#[derive(Clone)]
struct ModuleType {
    spec: Arc<ModuleSpec>,
    /// The type that implements it.
    type_name: &'static str,
}

#[derive(Clone)]
struct ClassType {
    spec: Arc<ClassSpec>,
    /// The type that implements it.
    type_name: &'static str,
}

/// An embedding host's export, made separately when each VM imports its module.
#[derive(Clone)]
pub struct ValueSpec {
    /// The name apps import.
    pub name: &'static str,
    ty: String,
    types: TsTypes,
    make: Arc<dyn Fn() -> Box<dyn ToJs> + Send + Sync>,
}

impl ValueSpec {
    /// Constructs the value on the VM's thread. The VM converts and owns it.
    pub fn make(&self) -> Box<dyn ToJs> {
        (self.make)()
    }
}

/// What a UI set exports to JS: its components and modules, and what it
/// passes on from the runtime. Cheap to clone.
#[derive(Clone, Default)]
pub struct Registry {
    types: Arc<FxHashMap<&'static str, ComponentType>>,
    modules: Arc<FxHashMap<&'static str, ModuleType>>,
    /// By the specifier of their set and their name: the sets merged for
    /// the core may have classes of the same name.
    classes: Arc<FxHashMap<(Option<&'static str>, &'static str), ClassType>>,
    values: Arc<Vec<ValueSpec>>,
    /// Values and types of `nsh/_core` exported as they are.
    reexports: Arc<(Vec<&'static str>, Vec<&'static str>)>,
    /// Values `nsh-js` makes for the set (declared by hand, not generated
    /// from a spec).
    native_values: Arc<Vec<&'static str>>,
    /// The runtime module the functions belong to (`nsh/android`): JS
    /// calls them as `nsh/android:BackHandler.exitApp`, apart from any UI set's.
    namespace: Option<&'static str>,
    /// The JS module a UI set is imported as (`app/native`).
    ui_set: Option<&'static str>,
    /// The files its crates ship ([`Registry::assets`]).
    assets: Arc<Vec<&'static [super::AssetFile]>>,
    /// Makes the design tokens of a theme ([`Registry::tokens_from`]).
    tokens: Option<super::TokenSource>,
    /// The UI sets served under paths of this one's specifier
    /// ([`Registry::submodule`]).
    submodules: Arc<Vec<Registry>>,
    /// What each engine serving the set runs once ([`Registry::setup`]).
    setups: Arc<Vec<Setup>>,
}

/// A function each engine serving a set runs once ([`Registry::setup`]).
type Setup = Arc<dyn Fn() + Send + Sync>;

impl fmt::Debug for Registry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_set().entries(self.types.keys()).finish()
    }
}

impl Registry {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Exports a value made by `make` once when each VM imports this registry.
    ///
    /// The factory runs on that VM's thread, before the importing app runs.
    /// Capture the embedding host's authorized state; return an [`super::Instance`]
    /// of a class without a constructor to expose an existing native capability.
    /// Cloned registries share the factory, never its produced JS objects.
    /// The host retains responsibility for closing external work and resources.
    ///
    /// # Panics
    ///
    /// When the name is not an ASCII JavaScript binding identifier, or is already
    /// exported by this registry.
    #[track_caller]
    pub fn value<T: Ret + 'static>(
        &mut self,
        name: &'static str,
        make: impl Fn() -> T + Send + Sync + 'static,
    ) -> &mut Self {
        let valid = name.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_alphabetic() || matches!(c, b'_' | b'$') || (i > 0 && c.is_ascii_digit())
        });
        let keyword = concat!(
            "await break case catch class const continue debugger default delete do else enum ",
            "export extends false finally for function if implements import in instanceof interface ",
            "let new null package private protected public return static super switch this throw ",
            "true try typeof var void while with yield arguments eval"
        ).split_ascii_whitespace().any(|word| word == name);
        assert!(
            !name.is_empty() && valid && !keyword,
            "invalid export name `{name}`"
        );
        let occupied = self.values.iter().any(|v| v.name == name)
            || self.types.values().any(|c| c.spec.export == name)
            || self.classes.keys().any(|(_, class)| *class == name)
            || self.modules.values().any(|m| {
                if m.spec.flat {
                    m.spec.functions.iter().any(|f| f.name == name)
                } else {
                    m.spec.name == name
                }
            })
            || self.reexports.0.contains(&name)
            || self.native_values.contains(&name);
        assert!(!occupied, "export `{name}` is registered twice");
        let mut refs = Vec::new();
        T::classes(&mut refs);
        self.classes_named(refs);
        assert!(
            !self.classes.keys().any(|(_, class)| *class == name),
            "export `{name}` is named like its class"
        );
        let mut types = TsTypes::default();
        let ty = T::ts_type(&mut types);
        Arc::make_mut(&mut self.values).push(ValueSpec {
            name,
            ty,
            types,
            make: Arc::new(move || Box::new(make())),
        });
        self
    }

    /// The embedding host's exports, in registration order.
    pub fn value_specs(&self) -> &[ValueSpec] {
        &self.values
    }

    /// Registers component `C` under its type's name, exported to JS as
    /// the type's own name ([`ComponentSpec::name`], [`ComponentSpec::export`]).
    ///
    /// # Panics
    ///
    /// When `C` is registered already, another type of the same name is
    /// (two versions of one crate), or another component of the set has the
    /// same export: a mistake in the code, caught by the app's first run.
    #[track_caller]
    pub fn register<C: Component>(&mut self) -> &mut Self {
        let spec = ComponentSpec::of::<C>();
        self.check_value_name(&spec.export);
        let types = Arc::make_mut(&mut self.types);
        if let Some(old) = types.get(spec.name) {
            let set = self.ui_set.or(self.namespace);
            panic!("{}", same_name(spec.name, old.id, TypeId::of::<C>(), set));
        }
        if self.classes.keys().any(|(_, name)| *name == spec.export) {
            panic!(
                "component `{}` is exported as `{}` like a class{}: rename one",
                spec.name,
                spec.export,
                of_set(self.ui_set.or(self.namespace)),
            );
        }
        if let Some(other) = types.values().find(|t| t.spec.export == spec.export) {
            panic!(
                "components `{}` and `{}` are both exported as `{}`{}: rename one",
                other.spec.name,
                spec.name,
                spec.export,
                of_set(self.ui_set.or(self.namespace)),
            );
        }
        types.insert(
            spec.name,
            ComponentType {
                spec: Arc::new(spec),
                make: make_instance::<C>,
                id: TypeId::of::<C>(),
            },
        );
        let mut refs = Vec::new();
        (C::METHODS.refs)(&mut refs);
        self.classes_named(refs)
    }

    /// Registers module `M`: its functions on a JS object named
    /// [`Module::NAME`] (merged into the component exported by that name, if
    /// the set has one).
    ///
    /// # Panics
    ///
    /// When the set has a module of that name already.
    #[track_caller]
    pub fn module<M: Module>(&mut self) -> &mut Self {
        if M::FLAT {
            for f in M::FUNCTIONS {
                self.check_value_name(f.name);
            }
        } else {
            self.check_value_name(M::NAME);
        }
        let type_name = std::any::type_name::<M>();
        if self.classes.keys().any(|(_, name)| *name == M::NAME) {
            panic!(
                "module `{type_name}` is named `{}` like a class{}: rename one",
                M::NAME,
                of_set(self.ui_set.or(self.namespace))
            );
        }
        let modules = Arc::make_mut(&mut self.modules);
        if let Some(old) = modules.get(M::NAME) {
            panic!(
                "{}",
                same_module(
                    M::NAME,
                    old.type_name,
                    type_name,
                    self.ui_set.or(self.namespace)
                )
            );
        }
        modules.insert(
            M::NAME,
            ModuleType {
                spec: Arc::new(ModuleSpec::of::<M>()),
                type_name,
            },
        );
        let mut refs = Vec::new();
        for f in M::FUNCTIONS {
            (f.refs)(&mut refs);
        }
        self.classes_named(refs)
    }

    /// Registers class `C` (`#[class]`): a JS class named [`Class::DEF`]'s
    /// name, which JS makes with `new` (when it has a constructor) and gets
    /// from the members that return one. The classes its members'
    /// signatures name are registered with it, as are those a module's
    /// functions or a component's methods name ([`Registry::module`],
    /// [`Registry::register`]): their objects reach JS, so they are
    /// exported and declared. Registering a class again does nothing.
    ///
    /// # Panics
    ///
    /// When the set has another class, a module or a component of that
    /// name already.
    #[track_caller]
    pub fn class<C: Class>(&mut self) -> &mut Self {
        self.class_def(C::DEF)
    }

    /// Registers the classes in `refs` (a signature names them), unless
    /// the set has them.
    #[track_caller]
    fn classes_named(&mut self, refs: Vec<&'static ClassDef>) -> &mut Self {
        for def in refs {
            self.class_def(def);
        }
        self
    }

    #[track_caller]
    fn class_def(&mut self, def: &'static ClassDef) -> &mut Self {
        self.check_value_name(def.name);
        let type_name = (def.type_name)();
        let set = self.ui_set.or(self.namespace);
        if let Some(old) = self.classes.get(&(set, def.name)) {
            if (old.spec.def.type_id)() == (def.type_id)() {
                return self;
            }
            panic!("{}", same_class(def.name, old.type_name, type_name, set));
        }
        if self.modules.contains_key(def.name)
            || self.types.values().any(|t| t.spec.export == def.name)
        {
            panic!(
                "class `{type_name}` is named `{}` like a module or a component{}: rename one",
                def.name,
                of_set(set)
            );
        }
        Arc::make_mut(&mut self.classes).insert(
            (set, def.name),
            ClassType {
                spec: Arc::new(ClassSpec::of(def)),
                type_name,
            },
        );
        // What its members name, in turn (it is registered: a cycle ends).
        let mut refs = Vec::new();
        for m in def.members {
            (m.refs)(&mut refs);
        }
        self.classes_named(refs)
    }

    /// Exports `values` and `types` of the runtime as they are (accessors
    /// such as `safeArea`, hooks, types such as `Insets`).
    pub fn reexport(&mut self, values: &[&'static str], types: &[&'static str]) -> &mut Self {
        for value in values {
            self.check_value_name(value);
        }
        let r = Arc::make_mut(&mut self.reexports);
        r.0.extend_from_slice(values);
        r.1.extend_from_slice(types);
        self
    }

    fn check_value_name(&self, name: &str) {
        assert!(
            !self.values.iter().any(|value| value.name == name),
            "export `{name}` is registered twice"
        );
    }

    /// The components of all of `sets`, for making them by name (the
    /// core's view of the sets a host serves). Not a module of its own.
    /// Components of different sets may share an export (JS imports them
    /// from different modules), not a name. Modules and classes are not
    /// in it: their calls carry what they run.
    ///
    /// # Panics
    ///
    /// When two sets register the same component or two types of the same
    /// name.
    #[track_caller]
    pub fn merged(sets: &[Registry]) -> Self {
        let mut out = Self::default();
        for set in sets.iter().flat_map(Registry::sets) {
            out.tokens = out.tokens.or(set.tokens);
            Arc::make_mut(&mut out.setups).extend(set.setups.iter().cloned());
            let types = Arc::make_mut(&mut out.types);
            for (name, ty) in set.types.iter() {
                if let Some(old) = types.insert(name, ty.clone()) {
                    panic!("{}, by two UI sets", same_name(name, old.id, ty.id, None));
                }
            }
        }
        out
    }

    /// The registry of a UI set apps import as `specifier`
    /// (`app/native`). An app's crate makes its own with
    /// `#[native_module("…")]`.
    pub fn ui_set(specifier: &'static str) -> Self {
        Self {
            ui_set: Some(specifier),
            ..Self::default()
        }
    }

    /// The JS module the registry is imported as: a UI set's, or the
    /// runtime module's (`None`: a Rust app's components).
    pub fn specifier(&self) -> Option<&'static str> {
        self.ui_set.or(self.namespace)
    }

    /// The runtime values and types exported as they are
    /// ([`Registry::reexport`]).
    pub fn reexports(&self) -> (&[&'static str], &[&'static str]) {
        (&self.reexports.0, &self.reexports.1)
    }

    /// Serves UI set `set` wherever this one is served, as a module of
    /// its own under a path of this set's specifier (`nsh/base/plot` of
    /// `nsh/base`, as `gpui-base`'s `plot` is a module of the crate): a
    /// family of components whose names (`Line`, `Grid`) only make sense
    /// together, apart from the set's other exports. Hosts, the toolchain
    /// and the declarations take the set's submodules with it
    /// ([`Registry::sets`]), so a list of UI sets names only the set.
    ///
    /// # Panics
    ///
    /// When `set`'s specifier is not a path under this set's.
    #[track_caller]
    pub fn submodule(&mut self, set: Registry) -> &mut Self {
        let under = match (self.ui_set, set.ui_set) {
            (Some(parent), Some(child)) => child
                .strip_prefix(parent)
                .is_some_and(|rest| rest.len() > 1 && rest.starts_with('/')),
            _ => false,
        };
        assert!(
            under,
            "a submodule is a UI set under a path of its set's specifier: {:?} under {:?}",
            set.ui_set, self.ui_set
        );
        Arc::make_mut(&mut self.submodules).push(set);
        self
    }

    /// This set and its submodules ([`Registry::submodule`]), each one
    /// module apps import: what a host serves and the toolchain declares
    /// for it.
    pub fn sets(&self) -> Vec<&Registry> {
        let mut out = vec![self];
        for sub in self.submodules.iter() {
            out.extend(sub.sets());
        }
        out
    }

    /// Exports `values` `nsh-js` makes for the set (`NavStack`, `NavPage`),
    /// declared by hand rather than generated from a spec.
    pub fn native_values(&mut self, values: &[&'static str]) -> &mut Self {
        for value in values {
            self.check_value_name(value);
        }
        Arc::make_mut(&mut self.native_values).extend_from_slice(values);
        self
    }

    /// Ships `files` with the apps that use the set (`assets!()`: a crate's
    /// `assets/` directory): `nsh run` serves them, `nsh package` copies
    /// them into the app, and the engine registers the fonts among them
    /// before the first render. `asset!` refers to one.
    pub fn assets(&mut self, files: &'static [super::AssetFile]) -> &mut Self {
        Arc::make_mut(&mut self.assets).push(files);
        self
    }

    /// Makes the design tokens of the app's theme file, and the defaults
    /// (`nsh-base`'s theme): the core reads `nsh.json`'s `"theme"` with it.
    pub fn tokens_from(&mut self, source: super::TokenSource) -> &mut Self {
        self.tokens = Some(source);
        self
    }

    /// Runs `f` once on each engine that serves the set, in its reactive
    /// runtime, before the app's first op: what the set's crates keep per
    /// engine is set up there (the languages an `Editor` knows,
    /// `nsh_base::editor::register_language`; a value of
    /// [`global`](super::prelude::global)), as a Rust app's root sets it up
    /// before its children. An app's crate calls it from its
    /// `#[native_module]` function.
    pub fn setup(&mut self, f: impl Fn() + Send + Sync + 'static) -> &mut Self {
        Arc::make_mut(&mut self.setups).push(Arc::new(f));
        self
    }

    /// Runs the functions [`Registry::setup`] gave the set (a merged set's:
    /// every set's, in order). The core runs them when it takes its sets.
    pub(crate) fn run_setups(&self) {
        for setup in self.setups.iter() {
            setup();
        }
    }

    /// The tokens of theme file `json` (`None`: the defaults), by the
    /// source a set brings ([`Registry::tokens_from`]; `None`: no set
    /// does).
    pub fn tokens(&self, json: Option<&str>) -> Option<Result<super::Tokens, String>> {
        self.tokens.map(|source| source(json))
    }

    /// How the set reads a theme file ([`Registry::tokens_from`]).
    pub(crate) fn token_source(&self) -> Option<super::TokenSource> {
        self.tokens
    }

    /// The files [`Registry::assets`] ships.
    pub fn asset_files(&self) -> impl Iterator<Item = &'static super::AssetFile> + '_ {
        self.assets.iter().flat_map(|files| files.iter())
    }

    /// The values of [`Registry::native_values`].
    pub fn native_value_names(&self) -> &[&'static str] {
        &self.native_values
    }

    /// A registry of the runtime's module `namespace` (`nsh/android`).
    pub(crate) fn runtime(namespace: &'static str) -> Self {
        Self {
            namespace: Some(namespace),
            ..Self::default()
        }
    }

    /// The runtime module the registry's functions belong to (`None`: a UI
    /// set's).
    pub fn namespace(&self) -> Option<&'static str> {
        self.namespace
    }

    /// The registered classes, by name.
    pub fn class_specs(&self) -> Vec<Arc<ClassSpec>> {
        let mut specs: Vec<_> = self.classes.values().map(|c| c.spec.clone()).collect();
        specs.sort_by_key(|s| s.name);
        specs
    }

    /// The registered modules, by name.
    pub fn module_specs(&self) -> Vec<Arc<ModuleSpec>> {
        let mut specs: Vec<_> = self.modules.values().map(|m| m.spec.clone()).collect();
        specs.sort_by_key(|s| s.name);
        specs
    }

    /// The module whose functions JS finds on the function `function` of
    /// a flat module of the set: a module named like it
    /// (`#[module(name = "test")]`: `test.skip`), as a module named like a
    /// component is on the component.
    pub fn function_members(&self, function: &str) -> Option<Arc<ModuleSpec>> {
        let exported = self.modules.values().any(|m| {
            m.spec.flat
                && m.spec
                    .functions
                    .iter()
                    .any(|f| !f.getter && f.name == function)
        });
        exported
            .then(|| {
                self.modules
                    .values()
                    .find(|m| !m.spec.flat && m.spec.name == function)
                    .map(|m| m.spec.clone())
            })
            .flatten()
    }

    /// The registered components, by export.
    pub fn specs(&self) -> Vec<Arc<ComponentSpec>> {
        let mut specs: Vec<_> = self.types.values().map(|t| t.spec.clone()).collect();
        specs.sort_by(|a, b| a.export.cmp(&b.export).then(a.name.cmp(b.name)));
        specs
    }

    /// The exports of the set that TS sees without documentation, by
    /// their TS names (`Gauge`, `Gauge.max`, `Gauge.onChange`,
    /// `Ledger.copy`, `new Account`, `Account.balance`): what to give a
    /// doc comment. A component is documented by its `#[component]`
    /// function, a module or class by its struct, the rest by their own
    /// (a setter needs none beside its getter's; a module merged into a
    /// component or a function of its name, or exported flat, by that
    /// component or function, or its functions).
    pub fn undocumented(&self) -> Vec<String> {
        let mut out = Vec::new();
        let specs = self.specs();
        for c in &specs {
            if c.doc.is_empty() {
                out.push(c.export.clone());
            }
            for p in c.props.iter().filter(|p| p.doc.is_empty()) {
                out.push(format!("{}.{}", c.export, p.name));
            }
            for e in c.events.iter().filter(|e| e.doc.is_empty()) {
                out.push(format!("{}.{}", c.export, handler_name(e.name)));
            }
            for m in c.methods.iter().filter(|m| m.doc.is_empty()) {
                out.push(format!("{}.{}", c.export, m.name));
            }
        }
        for m in self.module_specs() {
            let merged = specs.iter().any(|c| c.export == m.name)
                || (!m.flat && self.function_members(m.name).is_some());
            if m.doc.is_empty() && !merged && !m.flat {
                out.push(m.name.to_owned());
            }
            for f in m.functions.iter().filter(|f| f.doc.is_empty()) {
                out.push(if m.flat {
                    f.name.to_owned()
                } else {
                    format!("{}.{}", m.name, f.name)
                });
            }
        }
        for c in self.class_specs() {
            if c.doc.is_empty() {
                out.push(c.name.to_owned());
            }
            let documented_getter = |name: &str| {
                c.members
                    .iter()
                    .any(|m| m.kind == MemberKind::Getter && m.name == name && !m.doc.is_empty())
            };
            for m in c.members.iter().filter(|m| m.doc.is_empty()) {
                match m.kind {
                    MemberKind::Constructor => out.push(format!("new {}", c.name)),
                    MemberKind::Setter if documented_getter(m.name) => {}
                    _ => out.push(format!("{}.{}", c.name, m.name)),
                }
            }
        }
        out
    }

    /// A new instance of component `name`.
    pub(crate) fn make(&self, name: &str) -> Option<(Arc<ComponentSpec>, Box<dyn AnyInstance>)> {
        self.types.get(name).map(|t| (t.spec.clone(), (t.make)()))
    }
}

/// The message of two registrations under component name `name`.
fn same_name(name: &str, old: TypeId, new: TypeId, set: Option<&str>) -> String {
    if old == new {
        format!("component `{name}` is registered twice{}", of_set(set))
    } else {
        format!(
            "two different types named `{name}` are registered{} (two versions of one crate?)",
            of_set(set)
        )
    }
}

/// The message of two modules named `name`.
fn same_module(name: &str, old: &str, new: &str, set: Option<&str>) -> String {
    if old == new {
        format!("module `{old}` is registered twice{}", of_set(set))
    } else {
        format!(
            "modules `{old}` and `{new}` are both named `{name}`{}: rename one",
            of_set(set)
        )
    }
}

/// The message of two classes named `name`.
fn same_class(name: &str, old: &str, new: &str, set: Option<&str>) -> String {
    if old == new {
        format!("class `{old}` is registered twice{}", of_set(set))
    } else {
        format!(
            "classes `{old}` and `{new}` are both named `{name}`{}: rename one",
            of_set(set)
        )
    }
}

/// ` in `app/native`` for a registry with a specifier.
fn of_set(set: Option<&str>) -> String {
    set.map(|s| format!(" in `{s}`")).unwrap_or_default()
}

/// The declarations of what `registry`'s specs export: one component per
/// spec (by its [`ComponentSpec::export`] name), one object per module
/// (its type `<Name>Module`; merged into a component of the same name; a
/// flat module's functions one by one), one class per class, and the
/// named types they use.
/// Exports named in `omit` are left out (their types stay): `nsh-js`
/// declares them, building on the module (`BackHandlerModule & ...`), as
/// it declares the re-exports and native values it makes.
pub fn declarations(registry: &Registry, omit: &[&str]) -> String {
    let specs = registry.specs();
    let modules = registry.module_specs();
    let classes = registry.class_specs();
    use std::fmt::Write as _;
    let mut out = String::new();
    let doc = |out: &mut String, indent: &str, doc: &str| {
        if !doc.is_empty() {
            let _ = writeln!(out, "{indent}/** {doc} */");
        }
    };
    // The named types, once each.
    let mut types = TsTypes::default();
    for spec in &specs {
        types.merge(&spec.types);
    }
    for m in &modules {
        types.merge(&m.types);
    }
    for c in &classes {
        types.merge(&c.types);
    }
    for value in registry.value_specs() {
        types.merge(&value.types);
    }
    for declaration in types.declarations() {
        let _ = write!(out, "{declaration}\n\n");
    }
    let module_of = |name: &str| modules.iter().find(|m| m.name == name);
    // A function's signatures: its own, or its overloads.
    let signatures = |f: &FunctionSpec| {
        let one = |params: &[(&str, String, bool)], returns: &Option<String>| {
            let params = params
                .iter()
                .map(|(n, ts, optional)| format!("{n}{}: {ts}", if *optional { "?" } else { "" }))
                .collect::<Vec<_>>()
                .join(", ");
            let value = returns.clone().unwrap_or_else(|| "void".to_owned());
            let returns = if f.promises() {
                format!("Promise<{value}>")
            } else {
                value
            };
            (params, returns)
        };
        if f.overloads.is_empty() {
            vec![one(&f.params, &f.returns)]
        } else {
            f.overloads
                .iter()
                .map(|(params, returns)| one(params, returns))
                .collect()
        }
    };
    // A module's object type.
    let module_object = |out: &mut String, m: &ModuleSpec| {
        out.push_str("{\n");
        for f in &m.functions {
            for (params, returns) in signatures(f) {
                doc(out, "  ", f.doc);
                if f.getter {
                    let _ = writeln!(out, "  readonly {}: {returns};", f.name);
                    continue;
                }
                let _ = writeln!(out, "  {}({params}): {returns};", f.name);
            }
        }
        for constant in &m.constants {
            doc(out, "  ", constant.doc);
            let _ = writeln!(
                out,
                "  readonly {}: {};",
                constant.name,
                constant.value.ts_type()
            );
        }
        out.push('}');
    };
    for spec in &specs {
        // A component with rows is generic over their type, like `List`.
        // Props generic over their rows' type default it to `any`, so a mark
        // without rows of its own takes any field name.
        let (generic, params, extends) = match spec.items() {
            Some(_) => ("<T>", "<T>", ", ListItemsProps<T>"),
            None if spec.generic => ("<T>", "<T = any>", ""),
            None => ("", "", ""),
        };
        // A component with methods: its ref is an object of them.
        let host = if spec.methods.is_empty() {
            "ComponentHostProps"
        } else {
            let _ = write!(
                out,
                "/** The ref of `{0}`: its methods. */\nexport interface {0}Ref {{\n  /** The component's host node. */\n  readonly node: YNode;\n",
                spec.export
            );
            for m in &spec.methods {
                doc(&mut out, "  ", m.doc);
                let params = m
                    .params
                    .iter()
                    .map(|(n, ts, optional)| {
                        format!("{n}{}: {ts}", if *optional { "?" } else { "" })
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                let returns = match &m.returns {
                    Some(ts) => format!("Promise<{ts}>"),
                    None => "void".to_owned(),
                };
                let _ = writeln!(out, "  {}({params}): {returns};", m.name);
            }
            out.push_str("}\n\n");
            "Omit<ComponentHostProps, \"ref\">"
        };
        let _ = writeln!(
            out,
            "export interface {}Props{params} extends {host}{extends} {{",
            spec.export
        );
        if !spec.methods.is_empty() {
            let _ = writeln!(
                out,
                "  ref?: {0}Ref | ((ref: {0}Ref) => void);",
                spec.export
            );
        }
        for p in spec.props.iter().filter(|p| p.kind != PropKind::Items) {
            doc(&mut out, "  ", p.doc);
            let optional = if p.optional { "?" } else { "" };
            let _ = writeln!(out, "  {}{optional}: {};", p.name, p.ts);
        }
        for e in &spec.events {
            doc(&mut out, "  ", e.doc);
            let handler = handler_name(e.name);
            let arg = if e.data == "void" {
                String::new()
            } else if e.spread {
                e.data.clone()
            } else {
                format!("{}: {}", e.arg, e.data)
            };
            let _ = writeln!(out, "  {handler}?: ({arg}) => void;");
        }
        out.push_str("}\n\n");
        if omit.contains(&spec.export.as_str()) {
            continue;
        }
        doc(&mut out, "", spec.doc);
        // A module of the same name: its functions on the component.
        let mut with = String::new();
        if let Some(m) = module_of(&spec.export) {
            with.push_str(" & ");
            module_object(&mut with, m);
        }
        if spec.items().is_some() {
            // Arrays also have at(): infer rows from one data shape at a time.
            let _ = write!(
                out,
                "export declare const {0}: {{\n  <T>(props: Omit<{0}Props<T>, \"each\"> & {{ each: readonly T[] }}): JSX.Element;\n  <T>(props: Omit<{0}Props<T>, \"each\"> & {{ each: ReadonlyListSource<T> }}): JSX.Element;\n  <T>(props: {0}Props<T>): JSX.Element;\n}}{with};\n\n",
                spec.export,
            );
        } else {
            let _ = write!(
                out,
                "export declare const {0}: ({params}(props: {0}Props{generic}) => JSX.Element){with};\n\n",
                spec.export,
            );
        }
    }
    for m in &modules {
        if specs.iter().any(|s| s.export == m.name)
            || (!m.flat && registry.function_members(m.name).is_some())
        {
            continue;
        }
        if m.flat {
            for f in m
                .functions
                .iter()
                .filter(|f| !f.getter && !omit.contains(&f.name))
            {
                for (params, returns) in signatures(f) {
                    doc(&mut out, "", f.doc);
                    let _ = writeln!(
                        out,
                        "export declare function {}({params}): {returns};",
                        f.name
                    );
                }
                // A module of its name: its functions on the function.
                if let Some(members) = registry.function_members(f.name) {
                    let _ = writeln!(out, "export declare namespace {} {{", f.name);
                    for member in &members.functions {
                        for (params, returns) in signatures(member) {
                            doc(&mut out, "  ", member.doc);
                            let _ = if member.getter {
                                writeln!(out, "  const {}: {returns};", member.name)
                            } else {
                                writeln!(out, "  function {}({params}): {returns};", member.name)
                            };
                        }
                    }
                    for constant in &members.constants {
                        doc(&mut out, "  ", constant.doc);
                        let _ = writeln!(
                            out,
                            "  const {}: {};",
                            constant.name,
                            constant.value.ts_type()
                        );
                    }
                    out.push_str("}\n");
                }
                out.push('\n');
            }
            for constant in &m.constants {
                if !omit.contains(&constant.name) {
                    doc(&mut out, "", constant.doc);
                    let _ = writeln!(
                        out,
                        "export declare const {}: {};\n",
                        constant.name,
                        constant.value.ts_type()
                    );
                }
            }
            if m.default && !omit.contains(&"default") {
                let _ = write!(out, "declare const defaultExport: ");
                module_object(&mut out, m);
                // The registry's values `nsh-js` makes are on the object too.
                for native in registry.native_value_names() {
                    let _ = write!(out, " & {{ {native}: typeof {native} }}");
                }
                out.push_str(";\nexport default defaultExport;\n\n");
            }
            continue;
        }
        doc(&mut out, "", m.doc);
        let _ = write!(out, "export interface {}Module ", m.name);
        module_object(&mut out, m);
        out.push_str("\n\n");
        if !omit.contains(&m.name) {
            doc(&mut out, "", m.doc);
            let _ = write!(out, "export declare const {0}: {0}Module;\n\n", m.name);
        }
        if m.default && !omit.contains(&"default") {
            let _ = write!(
                out,
                "declare const defaultExport: {}Module;\nexport default defaultExport;\n\n",
                m.name
            );
        }
    }
    for c in classes.iter().filter(|c| !omit.contains(&c.name)) {
        class_declaration(&mut out, c);
    }
    for value in registry
        .value_specs()
        .iter()
        .filter(|v| !omit.contains(&v.name))
    {
        let _ = writeln!(out, "export declare const {}: {};", value.name, value.ty);
    }
    out
}

/// `export declare class Name { ... }`.
fn class_declaration(out: &mut String, c: &ClassSpec) {
    use std::fmt::Write as _;
    let doc = |out: &mut String, indent: &str, doc: &str| {
        if !doc.is_empty() {
            let _ = writeln!(out, "{indent}/** {doc} */");
        }
    };
    doc(out, "", c.doc);
    if c.def.interface {
        // No value: what its objects have.
        let _ = writeln!(out, "export interface {} {{", c.name);
        for m in &c.members {
            let params = m
                .params
                .iter()
                .map(|(n, ts, optional)| format!("{n}{}: {ts}", if *optional { "?" } else { "" }))
                .collect::<Vec<_>>()
                .join(", ");
            let value = m.returns.clone().unwrap_or_else(|| "void".to_owned());
            let returns = if m.is_async {
                format!("Promise<{value}>")
            } else {
                value
            };
            doc(out, "  ", m.doc);
            let has_setter = |name| {
                c.members
                    .iter()
                    .any(|s| s.kind == MemberKind::Setter && s.name == name)
            };
            let _ = match m.kind {
                MemberKind::Method => writeln!(out, "  {}({params}): {returns};", m.name),
                MemberKind::Getter if has_setter(m.name) => {
                    writeln!(out, "  {}: {returns};", m.name)
                }
                MemberKind::Getter => writeln!(out, "  readonly {}: {returns};", m.name),
                // A setter's property is its getter's; constructors and
                // statics belong to a class value it has none of.
                _ => Ok(()),
            };
        }
        out.push_str("}\n\n");
        return;
    }
    let _ = writeln!(out, "export declare class {} {{", c.name);
    if !c.members.iter().any(|m| m.kind == MemberKind::Constructor) {
        out.push_str("  /** Made by the class's members only. */\n  private constructor();\n");
    }
    let one = |m: &super::MemberSpec, params: &[(&str, String, bool)], returns: &Option<String>| {
        let params = params
            .iter()
            .map(|(n, ts, optional)| format!("{n}{}: {ts}", if *optional { "?" } else { "" }))
            .collect::<Vec<_>>()
            .join(", ");
        let value = returns.clone().unwrap_or_else(|| "void".to_owned());
        let returns = if m.is_async {
            format!("Promise<{value}>")
        } else {
            value
        };
        (params, returns)
    };
    for m in &c.members {
        if !m.overloads.is_empty() {
            for (params, returns) in &m.overloads {
                doc(out, "  ", m.doc);
                let (params, returns) = one(m, params, returns);
                let _ = match m.kind {
                    MemberKind::Static => {
                        writeln!(out, "  static {}({params}): {returns};", m.name)
                    }
                    _ => writeln!(out, "  {}({params}): {returns};", m.name),
                };
            }
            continue;
        }
        doc(out, "  ", m.doc);
        let (params, returns) = one(m, &m.params, &m.returns);
        let _ = match m.kind {
            MemberKind::Constructor => writeln!(out, "  constructor({params});"),
            MemberKind::Method => writeln!(out, "  {}({params}): {returns};", m.name),
            MemberKind::Getter => writeln!(out, "  get {}(): {returns};", m.name),
            MemberKind::Setter => writeln!(out, "  set {}({params});", m.name),
            MemberKind::Static => writeln!(out, "  static {}({params}): {returns};", m.name),
        };
    }
    out.push_str(
        "  /** Frees the Rust value now (else when the object is collected); the object throws after. */\n  dispose(): void;\n  [Symbol.dispose](): void;\n}\n\n",
    );
}

/// `press` -> `onPress`.
fn handler_name(event: &str) -> String {
    let mut chars = event.chars();
    match chars.next() {
        Some(first) => format!("on{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => "on".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prelude::*;

    #[derive(Default)]
    struct Stepper;

    /// Picks a number.
    #[derive(Clone, PartialEq, Props)]
    struct StepperProps {
        /// The value.
        value: f64,
        #[prop(default)]
        size: StepperSize,
        max_value: Option<f64>,
        /// Above the control.
        label: Option<Slot>,
        children: Children,
    }

    #[derive(Clone, Copy, PartialEq, Default, PropEnum)]
    enum StepperSize {
        #[default]
        Regular,
        ExtraLarge,
    }

    #[derive(Event)]
    enum StepperEvent {
        /// The value changed.
        Change {
            new_value: f64,
        },
        #[args(limit)]
        Limit(u32),
        Reset,
    }

    struct StepperApi;

    #[methods]
    impl StepperApi {
        /// Jumps to `value`.
        pub(crate) fn jump_to(&self, value: f64) {
            let _ = value;
        }

        pub(crate) fn value(&self) -> f64 {
            0.0
        }

        /// A helper without `pub`: not a method of the ref.
        #[allow(dead_code)]
        fn clamp(&self, value: f64) -> f64 {
            value
        }
    }

    impl Component for Stepper {
        type Props = StepperProps;
        type Event = StepperEvent;
        const METHODS: Methods = Methods::of::<StepperApi>();
        const DOC: &'static str = "Picks a number.";

        fn view(_: StepperProps, _: super::super::Scope<StepperEvent>) -> impl IntoElement {
            view()
        }
    }

    #[test]
    fn the_declarations_come_from_the_types() {
        let mut registry = Registry::new();
        registry.register::<Stepper>();
        let ts = declarations(&registry, &[]);
        for line in [
            "  /** The value. */\n  value: number;",
            "export type StepperSize = \"regular\" | \"extraLarge\";",
            "  size?: StepperSize;",
            "  maxValue?: number | null;",
            "  /** Above the control. */\n  label?: JSX.Element;",
            "  children?: JSX.Element;",
            "  /** The value changed. */\n  onChange?: (event: { newValue: number }) => void;",
            "  onLimit?: (limit: number) => void;",
            "  onReset?: () => void;",
            "/** Picks a number. */",
            "export interface StepperRef {",
            "  /** Jumps to `value`. */\n  jumpTo(value: number): void;",
            "  value(): Promise<number>;",
            "export interface StepperProps extends Omit<ComponentHostProps, \"ref\"> {\n  ref?: StepperRef | ((ref: StepperRef) => void);",
            "export declare const Stepper: ((props: StepperProps) => JSX.Element);",
        ] {
            assert!(ts.contains(line), "missing {line:?} in\n{ts}");
        }
        assert!(!ts.contains("clamp"), "a helper is not a method:\n{ts}");
        assert_eq!(StepperApi::METHODS.len(), 2);
        let mut props = StepperProps::initial();
        let size = |json| {
            let specs = StepperProps::spec(&mut TsTypes::default());
            let decode = specs
                .iter()
                .find(|p| p.name == "size")
                .unwrap()
                .decode
                .unwrap();
            super::super::json_host::decode(decode, json)
        };
        assert!(
            props
                .set("size", Some(size(serde_json::json!("extraLarge")).unwrap()))
                .unwrap()
        );
        assert!(props.size == StepperSize::ExtraLarge);
        // A value of another type: the conversion fails (JS warns, the prop
        // keeps its value), and so does a decoded value of another prop's
        // type.
        assert!(size(serde_json::json!("huge")).is_err());
        assert!(props.set("size", Some(AnyValue::new(1.0f64))).is_err());
        assert!(props.set("size", None).unwrap());
        assert!(props.size == StepperSize::Regular);
        let data = |e: &StepperEvent| super::super::json_host::event_data(e);
        assert_eq!(
            data(&StepperEvent::Change { new_value: 2.5 }),
            Some(serde_json::json!({ "newValue": 2.5 }))
        );
        assert_eq!(data(&StepperEvent::Limit(3)), Some(serde_json::json!(3)));
        assert_eq!(data(&StepperEvent::Reset), None);
        assert_eq!(StepperEvent::Reset.name(), "reset");
    }

    #[test]
    fn exports_without_docs_are_listed() {
        let mut registry = Registry::new();
        registry.register::<Stepper>();
        // `size`, `maxValue`, `children`, `onLimit`, `onReset` and the
        // ref's `value` have no doc comment.
        assert_eq!(
            registry.undocumented(),
            [
                "Stepper.size",
                "Stepper.maxValue",
                "Stepper.children",
                "Stepper.onLimit",
                "Stepper.onReset",
                "Stepper.value",
            ]
        );
        let mut r = Registry::ui_set("test/maker");
        r.module::<Maker>();
        assert_eq!(r.undocumented(), ["Maker.make", "new Lonely"]);
    }

    /// A class no set registers.
    #[crate::element::class]
    struct Lonely;

    #[crate::element::class]
    impl Lonely {
        pub(crate) fn new() -> Self {
            Lonely
        }
    }

    /// Makes a `Lonely`.
    #[crate::element::module]
    struct Maker;

    #[crate::element::module]
    impl Maker {
        pub(crate) fn make() -> Instance<Lonely> {
            Instance::new(Lonely)
        }
    }

    #[test]
    fn the_classes_a_signature_names_are_registered_with_it() {
        let mut r = Registry::ui_set("test/maker");
        r.module::<Maker>();
        // The module's result names `Lonely`: it is the set's, declared and
        // exported.
        let names: Vec<_> = r.class_specs().iter().map(|c| c.name).collect();
        assert_eq!(names, ["Lonely"]);
        let ts = declarations(&r, &[]);
        assert!(ts.contains("export declare class Lonely"), "{ts}");
        assert!(ts.contains("make(): Lonely;"), "{ts}");
        // Registering it again does nothing.
        r.class::<Lonely>();
        assert_eq!(r.class_specs().len(), 1);
        let _ = Registry::merged(&[r]);
    }

    #[test]
    fn host_values_cannot_shadow_registered_exports_in_either_order() {
        for value_first in [false, true] {
            for name in ["Lonely", "Maker", "Stepper", "native"] {
                let result = std::panic::catch_unwind(|| {
                    let mut registry = Registry::ui_set("test/host");
                    if value_first {
                        registry.value(name, || 1_u32);
                    }
                    match name {
                        "Lonely" => {
                            registry.class::<Lonely>();
                        }
                        "Maker" => {
                            registry.module::<Maker>();
                        }
                        "native" => {
                            registry.native_values(&["native"]);
                        }
                        _ => {
                            registry.register::<Stepper>();
                        }
                    }
                    if !value_first {
                        registry.value(name, || 1_u32);
                    }
                });
                assert!(result.is_err(), "{name}, value first: {value_first}");
            }
        }
    }

    #[test]
    fn host_value_names_generate_valid_bindings() {
        for name in ["", "bad-name", "a\0b", "default", "await", "eval"] {
            assert!(
                std::panic::catch_unwind(|| {
                    Registry::ui_set("test/host").value(name, || 0_u32);
                })
                .is_err(),
                "{name:?}"
            );
        }
    }

    /// Checks.
    #[crate::element::module]
    struct Checks;

    #[crate::element::module(flat)]
    impl Checks {
        /// Declares a check.
        pub(crate) fn check(name: String) {
            let _ = name;
        }
    }

    /// Unused: a module's doc when its functions are on `check`.
    #[crate::element::module]
    struct CheckVariants;

    #[crate::element::module(name = "check")]
    impl CheckVariants {
        /// How many variants there are.
        pub(crate) const COUNT: u32 = 2;

        /// Declares a check that does not run.
        pub(crate) fn skip(name: String) {
            let _ = name;
        }

        pub(crate) fn todo(name: String) {
            let _ = name;
        }
    }

    /// Named like no function of the set: an object of its own.
    #[crate::element::module]
    struct Loose;

    #[crate::element::module(name = "loose")]
    impl Loose {
        /// Nothing.
        pub(crate) fn nothing() {}
    }

    #[test]
    fn a_module_named_like_a_function_puts_its_functions_on_it() {
        let mut r = Registry::ui_set("test/checks");
        r.module::<Checks>()
            .module::<CheckVariants>()
            .module::<Loose>();
        assert_eq!(r.function_members("check").unwrap().name, "check");
        assert!(r.function_members("loose").is_none());
        let ts = declarations(&r, &[]);
        assert!(
            ts.contains(
                "/** Declares a check. */\n\
                 export declare function check(name: string): void;\n\
                 export declare namespace check {\n  \
                 /** Declares a check that does not run. */\n  \
                 function skip(name: string): void;\n  \
                 function todo(name: string): void;\n  \
                 /** How many variants there are. */\n  \
                 const COUNT: number;\n}\n"
            ),
            "{ts}"
        );
        assert!(
            !ts.contains("CheckVariants") && !ts.contains("checkModule"),
            "{ts}"
        );
        assert!(
            ts.contains("export declare const loose: looseModule;"),
            "{ts}"
        );
        // The members are documented as the function's.
        assert_eq!(r.undocumented(), ["check.todo"]);
        let described = super::super::description::SetDescription::of(&r).unwrap();
        let exports: Vec<_> = described
            .exports
            .iter()
            .map(|e| (e.name.as_str(), e.kind))
            .collect();
        assert_eq!(
            exports,
            [
                ("check", super::super::description::ExportKind::Function),
                ("loose", super::super::description::ExportKind::Module)
            ]
        );
    }

    mod clash {
        /// Another class named `Lonely`.
        #[crate::element::class]
        pub(super) struct Lonely;

        #[crate::element::class]
        impl Lonely {
            pub(super) fn new() -> Self {
                Lonely
            }
        }
    }

    #[test]
    fn a_clash_through_a_signature_names_both_types() {
        let mut r = Registry::ui_set("test/maker");
        r.class::<clash::Lonely>();
        // `Maker.make` names the other `Lonely`.
        let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            r.module::<Maker>();
        }))
        .unwrap_err();
        let message = failed.downcast_ref::<String>().unwrap();
        assert!(
            message.contains("`nsh_core::element::component::tests::clash::Lonely`")
                && message.contains("`nsh_core::element::component::tests::Lonely`"),
            "{message}"
        );
    }

    #[test]
    fn components_are_named_after_their_types() {
        let mut registry = Registry::ui_set("test/ui");
        registry.register::<Stepper>();
        let specs = registry.specs();
        assert_eq!(
            specs[0].name,
            "nsh_core::element::component::tests::Stepper"
        );
        assert_eq!(specs[0].export, "Stepper");
        assert_eq!(export_name("app::picker::Picker<app::Fruit>"), "Picker");
        assert_eq!(export_name("Bare"), "Bare");
    }

    mod other {
        use crate::prelude::*;

        /// Another component exported as `Stepper`.
        #[derive(Default)]
        pub(super) struct Stepper;

        impl Component for Stepper {
            type Props = ();
            type Event = NoEvent;

            fn view(_: (), _: crate::element::Scope<NoEvent>) -> impl IntoElement {
                view()
            }
        }
    }

    #[test]
    #[should_panic(
        expected = "components `nsh_core::element::component::tests::Stepper` and `nsh_core::element::component::tests::other::Stepper` are both exported as `Stepper` in `test/ui`"
    )]
    fn two_components_of_one_set_cannot_share_an_export() {
        Registry::ui_set("test/ui")
            .register::<Stepper>()
            .register::<other::Stepper>();
    }

    #[test]
    #[should_panic(
        expected = "component `nsh_core::element::component::tests::Stepper` is registered twice"
    )]
    fn a_component_is_registered_once() {
        Registry::new().register::<Stepper>().register::<Stepper>();
    }

    /// A set's submodules come with it, under paths of its specifier, and
    /// their components join the core's.
    #[test]
    fn a_sets_submodules_come_with_it() {
        let mut sub = Registry::ui_set("test/set/sub");
        sub.register::<Stepper>();
        let mut set = Registry::ui_set("test/set");
        set.submodule(sub);
        let specifiers: Vec<_> = set.sets().iter().map(|s| s.specifier()).collect();
        assert_eq!(specifiers, [Some("test/set"), Some("test/set/sub")]);
        assert_eq!(Registry::merged(&[set]).specs().len(), 1);
        // Only a path under the set's own specifier.
        let elsewhere = std::panic::catch_unwind(|| {
            Registry::ui_set("test/set").submodule(Registry::ui_set("test/settings"));
        });
        assert!(elsewhere.is_err());
    }

    #[test]
    fn sets_may_share_exports_but_not_components() {
        let mut a = Registry::ui_set("test/a");
        a.register::<Stepper>();
        let mut b = Registry::ui_set("test/b");
        b.register::<other::Stepper>();
        let merged = Registry::merged(&[a.clone(), b]);
        assert_eq!(merged.specs().len(), 2);
        let twice = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Registry::merged(&[a.clone(), a])
        }));
        let message = *twice.unwrap_err().downcast::<String>().unwrap();
        assert_eq!(
            message,
            "component `nsh_core::element::component::tests::Stepper` is registered twice, by two UI sets"
        );
    }
}
