//! Modules: functions a UI set exports to JS without a component
//! (`AlertDialog.show(...)`, `Keyboard.dismiss()`), written in Rust with
//! `#[module]` and generated into the set's JS module like its components.
//! The signature decides how a call runs: a function without a context
//! runs in the JS call and returns its value (as a class's method does);
//! one taking `cx: &mut ModuleCx` is an op, ordered with the props set
//! before it (a `Promise` when it returns a value, `Result<(), E>`
//! included; `undefined` when it returns nothing: nothing answers it); an
//! `async fn` runs as a task of the core (a `Promise`, of `void` too). In
//! every kind the arguments are converted in the JS call, and the op
//! carries a closure holding them (`super::call`).

use std::{future::Future, pin::Pin};

use super::{
    DialogAnswer, TsType, TsTypes,
    call::{JsResult, OpCall},
    class::{AsyncCall, Thrown},
    js::{JsHost, JsRaw},
    task::{self, Action},
};
use crate::{Command, Dialog, LayoutAnimation, ROOT_ID, StatusBarSetting};

/// A JS object of functions (`#[module]` implements it).
pub trait Module {
    /// Its JS name: the type's own (`#[module] impl Keyboard`: `Keyboard`), which
    /// `#[module]` writes; JS calls its functions by it (`Keyboard.dismiss`).
    const NAME: &'static str;
    /// Documentation (the `impl` block's doc comment).
    const DOC: &'static str;
    /// Its functions.
    const FUNCTIONS: &'static [Function];
    /// Its functions are exported one by one
    /// rather than as an object (`#[module(flat)]`).
    const FLAT: bool = false;
    /// Export the same flat module object as `default`.
    const DEFAULT: bool = false;
    /// Associated primitive constants exported with the functions.
    const CONSTANTS: &'static [Constant] = &[];
}

/// An owned primitive constant, shared by native exports and declarations.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub enum ConstantValue {
    /// No value; the default descriptor's value.
    #[default]
    Undefined,
    /// A static UTF-8 string.
    String(&'static str),
    /// A JavaScript number.
    Number(f64),
    /// A JavaScript boolean.
    Bool(bool),
}

impl ConstantValue {
    /// The TypeScript primitive corresponding to this value.
    pub const fn ts_type(self) -> &'static str {
        match self {
            Self::Undefined => "undefined",
            Self::String(_) => "string",
            Self::Number(_) => "number",
            Self::Bool(_) => "boolean",
        }
    }
}

/// One typed associated constant exported by a module.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct Constant {
    /// Its JS name (preserved, including uppercase names).
    pub name: &'static str,
    /// Documentation.
    pub doc: &'static str,
    /// Its primitive value and declaration type.
    pub value: ConstantValue,
}

impl Constant {
    /// Builds a constant descriptor, including from generated downstream code.
    pub const fn new(name: &'static str, doc: &'static str, value: ConstantValue) -> Self {
        Self { name, doc, value }
    }
}

/// A module function's parameter: its JS name, TypeScript type, and
/// whether it may be left out.
pub type ModuleParam = (&'static str, TsType, bool);

/// The future of an `async` function or member: its result, or the
/// message the `Promise` rejects with.
pub type ModuleFuture = Pin<Box<dyn Future<Output = JsResult>>>;

/// A function that runs in the JS call: it converts the call's values
/// directly; its result is an owned JS value.
pub type SyncCall = fn(&dyn JsHost) -> Result<JsRaw, Thrown>;

/// How a module function runs.
#[derive(Clone, Copy)]
pub enum FunctionCall {
    /// In the JS call (no context, not `async`): its value, or what it
    /// throws.
    Sync(SyncCall),
    /// As an op, with a [`ModuleCx`], in order with what JS set before it
    /// (its arguments converted in the JS call); an error rejects the
    /// `Promise` (a wrong argument of one returning nothing throws).
    Op(fn(&dyn JsHost) -> Result<OpCall, Thrown>),
    /// As a task started in order with the UI's ops (its arguments
    /// converted in the JS call): it reaches the platform with the same free
    /// functions views use (`dialog`, `clipboard_string`, ...).
    Async(AsyncCall),
    /// In the JS call, returning a task's start ([`super::Later`]): what
    /// the call throws throws there; JS gets a promise of the task.
    Start(AsyncCall),
}

impl std::fmt::Debug for FunctionCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.kind())
    }
}

impl FunctionCall {
    /// What it is, for the glue and the declarations.
    pub fn kind(&self) -> FunctionKind {
        match self {
            FunctionCall::Sync(_) => FunctionKind::Sync,
            FunctionCall::Op(_) => FunctionKind::Op,
            FunctionCall::Async(_) | FunctionCall::Start(_) => FunctionKind::Async,
        }
    }
}

/// How a module function runs ([`FunctionCall`]), for the glue and the
/// declarations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FunctionKind {
    /// In the JS call: TS gets the value.
    Sync,
    /// An op: TS gets a promise of the value; without one (`()`), nothing
    /// (`void`): the op runs in order with the UI, and no reply comes back.
    Op,
    /// A task: TS gets a promise of the value (`Promise<void>` without
    /// one, settled when the task ends).
    Async,
}

/// A function of a module (`#[module]` makes them).
pub struct Function {
    /// Its JS name (`alert`).
    pub name: &'static str,
    /// Documentation.
    pub doc: &'static str,
    /// Its parameters.
    pub params: &'static [ModuleParam],
    /// The TypeScript type of its result; `None`: nothing (`void`; a
    /// promise of it for a task).
    pub returns: Option<TsType>,
    /// The classes its parameters and result name.
    pub refs: super::ClassRefs,
    /// How it runs.
    pub call: FunctionCall,
    /// A getter of the module's object (`#[getter]`: `process.env`), read
    /// as a property and never a named export of a flat module.
    pub getter: bool,
    /// The signatures TypeScript sees instead of the one above, when the
    /// result's type depends on the arguments (`#[overload(..)]`).
    pub overloads: &'static [Overload],
}

/// One TypeScript signature of a function with several
/// (`#[overload(fn(path: String) -> Vec<u8>)]`): its parameters and the
/// type of its result (a promise of it when the function's is one).
#[derive(Debug, Clone, Copy)]
pub struct Overload {
    /// Its parameters.
    pub params: &'static [ModuleParam],
    /// The TypeScript type of its result.
    pub returns: Option<TsType>,
}

/// A signature of [`FunctionSpec::overloads`]: its parameters (JS name,
/// TypeScript type, optional) and its result's type.
pub type OverloadSpec = (Vec<(&'static str, String, bool)>, Option<String>);

/// One function, for the glue and its declarations.
#[derive(Debug, Clone)]
pub struct FunctionSpec {
    /// Its JS name.
    pub name: &'static str,
    /// Documentation.
    pub doc: &'static str,
    /// Its parameters: JS name, TypeScript type, optional.
    pub params: Vec<(&'static str, String, bool)>,
    /// The TypeScript type of its result.
    pub returns: Option<String>,
    /// How it runs.
    pub kind: FunctionKind,
    /// The call.
    pub call: FunctionCall,
    /// A getter of the module's object ([`Function::getter`]).
    pub getter: bool,
    /// The signatures TypeScript sees instead ([`Function::overloads`]).
    pub overloads: Vec<OverloadSpec>,
}

impl FunctionSpec {
    /// Whether JS gets a `Promise` of the result: a task always, an op
    /// when it returns a value (`Result<(), E>` too, rejected with an
    /// `Err`). An op returning `()` gives `undefined` (`void`): it runs in
    /// order with the UI and nothing answers it, and a wrong argument
    /// throws in the call.
    pub fn promises(&self) -> bool {
        match self.kind {
            FunctionKind::Sync => false,
            FunctionKind::Op => self.returns.is_some(),
            FunctionKind::Async => true,
        }
    }
}

/// What a module is to JS.
#[derive(Debug, Default, Clone)]
#[non_exhaustive]
pub struct ModuleSpec {
    /// Its JS name.
    pub name: &'static str,
    /// Documentation.
    pub doc: &'static str,
    /// Its functions.
    pub functions: Vec<FunctionSpec>,
    /// Exported one by one ([`Module::FLAT`]).
    pub flat: bool,
    /// A default export of the same flat module object.
    pub default: bool,
    /// Primitive constants, including their declaration types.
    pub constants: Vec<Constant>,
    /// The named TypeScript types they use.
    pub types: TsTypes,
}

impl ModuleSpec {
    pub(crate) fn of<M: Module>() -> Self {
        let mut types = TsTypes::default();
        let functions = M::FUNCTIONS
            .iter()
            .map(|f| FunctionSpec {
                name: f.name,
                doc: f.doc,
                params: f
                    .params
                    .iter()
                    .map(|(n, ts, optional)| (*n, ts(&mut types), *optional))
                    .collect(),
                returns: f.returns.map(|ts| ts(&mut types)),
                kind: f.call.kind(),
                call: f.call,
                getter: f.getter,
                overloads: f
                    .overloads
                    .iter()
                    .map(|o| {
                        let params = o
                            .params
                            .iter()
                            .map(|(n, ts, optional)| (*n, ts(&mut types), *optional))
                            .collect();
                        (params, o.returns.map(|ts| ts(&mut types)))
                    })
                    .collect(),
            })
            .collect();
        Self {
            name: M::NAME,
            doc: M::DOC,
            functions,
            flat: M::FLAT,
            default: M::DEFAULT,
            constants: M::CONSTANTS.to_vec(),
            types,
        }
    }
}

/// `future`, with a panic in it as its error (a promise JS waits for
/// rejects with the message).
pub(crate) async fn catching(future: ModuleFuture) -> JsResult {
    struct Caught(ModuleFuture);
    impl Future for Caught {
        type Output = JsResult;

        fn poll(
            mut self: Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Self::Output> {
            let future = &mut self.0;
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| future.as_mut().poll(cx)))
                .unwrap_or_else(|payload| {
                    std::task::Poll::Ready(Err(super::component::panic_message(payload).into()))
                })
        }
    }
    Caught(future).await
}

/// The context of a module function that is not `async`: the platform's
/// services, applied in order right after the call (an `async` one uses the
/// free functions, `dialog(..)`, ...).
#[derive(Default)]
pub struct ModuleCx {
    pub(crate) actions: Vec<Action>,
}

impl ModuleCx {
    /// Shows `dialog`; await the answer in an `async` function.
    pub fn dialog(&mut self, dialog: Dialog) -> DialogAnswer {
        let (answer, slot) = DialogAnswer::new();
        self.actions.push(Action::Dialog(dialog, slot));
        answer
    }

    /// Unfocuses the focused input, hiding the software keyboard.
    pub fn dismiss_keyboard(&mut self) {
        self.actions.push(Action::Command(ROOT_ID, Command::Blur));
    }

    /// Changes what functions set for the status bar (the fields `patch`
    /// sets), under the settings components render.
    pub fn set_status_bar(&mut self, patch: StatusBarSetting) {
        self.actions.push(task::status_bar(patch));
    }

    /// Animates the layout changes of the next commit.
    pub fn animate_layout(&mut self, animation: LayoutAnimation) {
        self.actions.push(Action::Command(
            ROOT_ID,
            Command::LayoutAnimation(animation),
        ));
    }

    /// The screen reader reads `message` (TS:
    /// `announce`).
    pub fn announce_for_accessibility(&mut self, message: impl Into<String>) {
        self.actions.push(super::services::announce(message.into()));
    }

    /// Puts `text` on the system clipboard (TS: `Clipboard.writeText`).
    pub fn set_clipboard(&mut self, text: impl Into<String>) {
        self.actions
            .push(super::services::set_clipboard(text.into()));
    }

    /// Puts the image of a `data:` URI on the system clipboard (TS:
    /// `Clipboard.writeImage`).
    pub fn set_clipboard_image(&mut self, uri: impl Into<String>) {
        self.actions
            .push(super::services::set_clipboard_image(uri.into()));
    }

    /// Shows the surface in `appearance` whatever the system's (TS:
    /// `setColorScheme`): [`crate::prelude::dark`] (the theme's mode),
    /// `dark:` classes and the platform's controls follow it;
    /// [`crate::platform::Appearance::System`] follows the system again.
    pub fn set_color_scheme(&mut self, appearance: crate::platform::Appearance) {
        self.actions.push(Action::Appearance(appearance));
    }

    /// Asks the platform for `action` (the runtime's own modules).
    pub(crate) fn act(&mut self, action: Action) {
        self.actions.push(action);
    }
}

#[cfg(test)]
mod descriptor_tests {
    use super::*;

    #[nsh_macros::module]
    struct Metadata;

    #[nsh_macros::module(flat, default)]
    impl Metadata {
        /// An arbitrary string constant; no name-specific inference.
        pub(crate) const LABEL: &'static str = "native";
        pub(crate) const COUNT: i32 = -7;
        pub(crate) const ENABLED: bool = true;
        #[cfg(any())]
        pub(crate) const OMITTED: bool = false;

        pub(crate) fn version() -> u32 {
            1
        }
    }

    #[test]
    fn descriptors_preserve_constants_default_and_value_derived_types() {
        let module = ModuleSpec::of::<Metadata>();
        assert!(module.flat && module.default);
        assert_eq!(module.functions[0].name, "version");
        assert_eq!(module.constants.len(), 3);
        assert_eq!(module.constants[0].name, "LABEL");
        assert_eq!(module.constants[0].value, ConstantValue::String("native"));
        assert_eq!(module.constants[1].value, ConstantValue::Number(-7.0));
        assert_eq!(module.constants[2].value, ConstantValue::Bool(true));
        assert_eq!(
            module
                .constants
                .iter()
                .map(|c| c.value.ts_type())
                .collect::<Vec<_>>(),
            ["string", "number", "boolean"]
        );
    }

    #[test]
    fn descriptors_have_forward_compatible_defaults() {
        let constant = Constant::default();
        assert_eq!(constant.value, ConstantValue::Undefined);
        assert_eq!(constant.value.ts_type(), "undefined");
        let module = ModuleSpec::default();
        assert!(!module.flat && !module.default);
        assert!(module.functions.is_empty() && module.constants.is_empty());
    }
}
