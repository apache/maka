//! Classes: Rust types TypeScript uses as classes (`new Tally(3)`), written
//! with `#[class]` on a struct and its `impl` block and registered with
//! [`super::Registry::class`].
//!
//! An instance lives in Rust ([`Instance`]: the value in an `Rc<RefCell>`)
//! and is owned by its JS object: the object being collected drops it, and
//! `dispose()` (or `[Symbol.dispose]`) drops it at once; using the object
//! after that throws. Members that are not `async` (the constructor
//! `new`, `&self` / `&mut self` methods, getters and setters, statics) run
//! inside the JS call, outside the core, converting JS values directly
//! ([`JsValue::from_js`]); a method borrows its instance for the call, so
//! a re-entrant use of it throws instead of aliasing. `async` members
//! (`this: Instance<Self>`) are ops like `async` module functions: their
//! arguments are converted in the JS call, the op carries the task's start
//! (with the instance), and JS gets a promise the core's result settles
//! (`super::call`). JS functions cross as callbacks (`super::callback`).

use std::{
    any::{Any, TypeId},
    cell::{Ref, RefCell, RefMut},
    fmt,
    rc::Rc,
};

use super::{
    JsValue, PropError, TsType, TsTypes,
    call::{JsResult, TaskStart},
    callback::{Trace, Tracer},
    js::{JsHost, JsIn, JsOwned, JsRaw},
    module::ModuleParam,
};

// --- The class -----------------------------------------------------------------------

/// A Rust type JS uses as a class. `#[class]` on the struct (its
/// [`Trace`]) and on its `impl` block (this) implements it.
pub trait Class: Trace + Sized + 'static {
    /// The class: its JS name (the type's), documentation and members.
    const DEF: &'static ClassDef;
}

/// What a class is: its name and members (`#[class]` writes it).
pub struct ClassDef {
    /// Its JS name: the type's own (`Tally`).
    pub name: &'static str,
    /// Documentation (the struct's doc comment).
    pub doc: &'static str,
    /// The type, telling two classes of the same name apart.
    pub type_id: fn() -> TypeId,
    /// The type's Rust path, for messages (`app::ledger::Ledger`).
    pub type_name: fn() -> &'static str,
    /// Its members: the constructor, methods, accessors and statics.
    pub members: &'static [Member],
    /// Its objects come from members only and its module exports no value
    /// of it: declared as an `interface` (`#[class(interface)]`: `fs`'s
    /// `Stats`).
    pub interface: bool,
}

impl ClassDef {
    /// Its constructor (`new`), if JS can make one.
    pub fn constructor(&self) -> Option<&'static Member> {
        self.members
            .iter()
            .find(|m| m.kind == MemberKind::Constructor)
    }
}

impl fmt::Debug for ClassDef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClassDef")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

/// What a member of a class is to JS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberKind {
    /// `new Tally(...)`.
    Constructor,
    /// `tally.add(...)`.
    Method,
    /// `tally.count`.
    Getter,
    /// `tally.count = ...`.
    Setter,
    /// `Tally.parse(...)`.
    Static,
}

/// A member of a class (`#[class]` makes them).
pub struct Member {
    /// Its JS name (`add`; a getter's and its setter's are the property's).
    pub name: &'static str,
    /// Documentation.
    pub doc: &'static str,
    /// What it is.
    pub kind: MemberKind,
    /// Its parameters.
    pub params: &'static [ModuleParam],
    /// The TypeScript type of its result (`None`: nothing).
    pub returns: Option<TsType>,
    /// The classes its parameters and result name.
    pub refs: ClassRefs,
    /// How it runs.
    pub call: MemberCall,
    /// The signatures TypeScript sees instead of the one its types give
    /// (`#[overload(fn(..) -> ..)]`), as a module function's: what an
    /// argument selects (`on("exit", ..)`).
    pub overloads: &'static [super::Overload],
}

/// Adds the classes a signature names (its parameters' and result's
/// types: [`Arg::classes`], [`Ret::classes`]) to the list: registering it
/// registers them ([`super::Registry::class`]). Not stripped from builds
/// without declarations: JS needs the classes there too.
pub type ClassRefs = fn(&mut Vec<&'static ClassDef>);

/// An `async` member's or function's call, its arguments (and instance)
/// converted in the JS call: the start of its task.
pub type AsyncCall = fn(&dyn JsHost) -> Result<TaskStart, Thrown>;

/// How a member (or a synchronous module function) runs.
#[derive(Clone, Copy)]
pub enum MemberCall {
    /// In the JS call, converting the call's values directly; the result
    /// is an owned JS value.
    Sync(fn(&dyn JsHost) -> Result<JsRaw, Thrown>),
    /// As a task of the core, started in order with the UI's ops; JS gets
    /// a promise.
    Async(AsyncCall),
    /// In the JS call, returning a task's start ([`super::Later`]): what
    /// the call throws throws there; JS gets a promise of the task.
    Start(AsyncCall),
}

impl MemberCall {
    /// Whether JS gets a promise.
    pub fn is_async(&self) -> bool {
        matches!(self, MemberCall::Async(_) | MemberCall::Start(_))
    }
}

/// What a synchronous call throws in JS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Thrown {
    /// A `TypeError`: a wrong argument, a disposed or busy instance.
    Type(String),
    /// A `RangeError`: a value past a limit ([`super::JsError::Range`]).
    Range(String),
    /// An `Error`: the member's `Err`, or its panic.
    Error(String),
    /// One of those with properties (`code`, ...: [`super::JsError::with`]).
    Fields(Box<super::ErrorFields>),
}

impl Thrown {
    /// Its message.
    pub fn message(&self) -> &str {
        match self {
            Thrown::Type(m) | Thrown::Range(m) | Thrown::Error(m) => m,
            Thrown::Fields(f) => &f.message,
        }
    }
}

impl From<PropError> for Thrown {
    fn from(e: PropError) -> Self {
        Thrown::Type(e.0)
    }
}

impl From<String> for Thrown {
    fn from(message: String) -> Self {
        Thrown::Error(message)
    }
}

impl From<&str> for Thrown {
    fn from(message: &str) -> Self {
        Thrown::Error(message.to_owned())
    }
}

impl fmt::Display for Thrown {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

// --- Instances ----------------------------------------------------------------

/// An instance of class `C`: a handle of the value its JS object owns
/// (cheap to clone). [`Instance::with`] / [`Instance::with_mut`] borrow
/// the value: in an `async` member, between awaits.
///
/// A value whose JS object goes drops inside QuickJS's finalizer, in a
/// collection or when the object's last reference goes, where no JS runs:
/// a callback's `call` fails there, and `post` queues the call at the end
/// for the next turn (not parked in program order). Before it drops, the callbacks the value alone keeps
/// (its traced fields, and the instances it alone holds) are released. So
/// a `Drop` that moves out an instance it held as the only handle (into a
/// static, a task) keeps that instance, but with dead callbacks: calling
/// them fails and posting them does nothing.
pub struct Instance<C: 'static> {
    cell: Rc<InstanceCell<C>>,
}

impl<C> Clone for Instance<C> {
    fn clone(&self) -> Self {
        Self {
            cell: self.cell.clone(),
        }
    }
}

impl<C> fmt::Debug for Instance<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Instance<{}>", std::any::type_name::<C>())
    }
}

/// What an [`Instance`] points to.
struct InstanceCell<C> {
    /// `None` once disposed.
    value: RefCell<Option<C>>,
}

impl<C: Class> Instance<C> {
    /// A new instance holding `value` (its JS object is made when it
    /// reaches JS).
    pub fn new(value: C) -> Self {
        Self {
            cell: Rc::new(InstanceCell {
                value: RefCell::new(Some(value)),
            }),
        }
    }

    /// Runs `f` with the value borrowed.
    ///
    /// # Panics
    ///
    /// When the instance was disposed, or `f` runs while the value is
    /// borrowed mutably (a re-entrant use).
    #[track_caller]
    pub fn with<R>(&self, f: impl FnOnce(&C) -> R) -> R {
        match self.borrow() {
            Ok(value) => f(&value),
            Err(e) => panic!("{e}"),
        }
    }

    /// Runs `f` with the value borrowed mutably.
    ///
    /// # Panics
    ///
    /// When the instance was disposed, or the value is borrowed (a
    /// re-entrant use).
    #[track_caller]
    pub fn with_mut<R>(&self, f: impl FnOnce(&mut C) -> R) -> R {
        match self.borrow_mut() {
            Ok(mut value) => f(&mut value),
            Err(e) => panic!("{e}"),
        }
    }

    /// Whether the value was dropped ([`Instance::dispose`], JS's
    /// `dispose()`).
    pub fn is_disposed(&self) -> bool {
        matches!(self.cell.value.try_borrow().as_deref(), Ok(None))
    }

    /// Drops the value now (JS's `dispose()`): its JS object throws when
    /// used after. Nothing when it was dropped already.
    ///
    /// # Panics
    ///
    /// When the value is borrowed.
    #[track_caller]
    pub fn dispose(&self) {
        if let Err(e) = self.cell.dispose() {
            panic!("{e}");
        }
    }

    /// Whether `self` and `other` are the same instance.
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.cell, &other.cell)
    }

    fn borrow(&self) -> Result<Ref<'_, C>, Thrown> {
        let value = self
            .cell
            .value
            .try_borrow()
            .map_err(|_| Thrown::Type(format!("{} used re-entrantly", C::DEF.name)))?;
        Ref::filter_map(value, Option::as_ref)
            .map_err(|_| Thrown::Type(format!("{} is disposed", C::DEF.name)))
    }

    fn borrow_mut(&self) -> Result<RefMut<'_, C>, Thrown> {
        let value = self
            .cell
            .value
            .try_borrow_mut()
            .map_err(|_| Thrown::Type(format!("{} used re-entrantly", C::DEF.name)))?;
        RefMut::filter_map(value, Option::as_mut)
            .map_err(|_| Thrown::Type(format!("{} is disposed", C::DEF.name)))
    }

    /// Whether this is the only handle of the instance (no JS object, task
    /// or other value holds it).
    pub(super) fn only_handle(&self) -> bool {
        Rc::strong_count(&self.cell) == 1
    }

    /// Reports the callbacks the value keeps.
    pub(super) fn trace_value(&self, tracer: &mut Tracer<'_>) {
        self.cell.trace(tracer);
    }

    /// The instance, type-erased (what JS objects and the table hold).
    fn erased(&self) -> Rc<dyn ClassInstance> {
        self.cell.clone()
    }

    /// `any` as an instance of `C` (`None`: another class's).
    fn of(any: Rc<dyn ClassInstance>) -> Option<Self> {
        let any: Rc<dyn Any> = any;
        any.downcast::<InstanceCell<C>>()
            .ok()
            .map(|cell| Self { cell })
    }
}

/// An instance of some class, as its JS object and the table hold it.
#[doc(hidden)]
pub trait ClassInstance: Any {
    /// Its class.
    fn def(&self) -> &'static ClassDef;
    /// Drops the value (`Err` when it is borrowed).
    fn dispose(&self) -> Result<(), String>;
    /// Whether it was disposed.
    fn disposed(&self) -> bool;
    /// Reports the callbacks the value keeps (nothing while it is
    /// borrowed).
    fn trace(&self, tracer: &mut Tracer<'_>);
}

impl<C: Class> ClassInstance for InstanceCell<C> {
    fn def(&self) -> &'static ClassDef {
        C::DEF
    }

    fn dispose(&self) -> Result<(), String> {
        let value = self
            .value
            .try_borrow_mut()
            .map_err(|_| format!("{} used re-entrantly", C::DEF.name))?
            .take();
        // Dropped after the borrow: its drop may reach JS (callbacks).
        drop(value);
        Ok(())
    }

    fn disposed(&self) -> bool {
        matches!(self.value.try_borrow().as_deref(), Ok(None))
    }

    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Ok(value) = self.value.try_borrow()
            && let Some(value) = &*value
        {
            value.trace(tracer);
        }
    }
}

// --- What crosses -----------------------------------------------------------------

/// A parameter of a class's member or a function: a [`JsValue`] type, an
/// instance ([`Instance`]; `&Other` / `&mut Other` borrow one for the
/// call) or a [`super::Callback`], converted from JS in the JS call.
pub trait Arg: Sized {
    /// Its TypeScript type.
    fn ts_type(types: &mut TsTypes) -> String;
    /// The value of a JS argument.
    fn from_js(value: JsIn<'_>) -> Result<Self, PropError>;
    /// Adds the classes the type names (an instance's, a callback's
    /// arguments').
    #[doc(hidden)]
    fn classes(_out: &mut Vec<&'static ClassDef>) {}
}

impl<T: JsValue> Arg for T {
    fn ts_type(types: &mut TsTypes) -> String {
        T::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        T::from_js(value)
    }
}

/// The instance a JS object of `C` holds (another class's, or another
/// value, is refused).
impl<C: Class> Arg for Instance<C> {
    fn ts_type(types: &mut TsTypes) -> String {
        types.class(C::DEF)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        value
            .host()
            .instance(value.raw())
            .and_then(Instance::of)
            .ok_or_else(|| value.expected(&format!("a {}", C::DEF.name)))
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        out.push(C::DEF);
    }
}

/// `null` or `undefined` is `None`.
impl<C: Class> Arg for Option<Instance<C>> {
    fn ts_type(types: &mut TsTypes) -> String {
        format!("{} | null", <Instance<C> as Arg>::ts_type(types))
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.is_nullish() {
            return Ok(None);
        }
        Instance::from_js(value).map(Some)
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        out.push(C::DEF);
    }
}

/// A result of a class's member: a [`JsValue`] type, `()`, an instance
/// (the JS object it has, or a new one), or a class's value (`#[class]`
/// implements it for the struct: a new instance).
pub trait Ret: Sized {
    /// `()`: nothing (a callback taking it has no parameters).
    const UNIT: bool = false;
    /// Its TypeScript type.
    fn ts_type(types: &mut TsTypes) -> String;
    /// The value for JS.
    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError>;
    /// Adds the classes the type names (an instance's).
    #[doc(hidden)]
    fn classes(_out: &mut Vec<&'static ClassDef>) {}
}

impl<T: JsValue> Ret for T {
    fn ts_type(types: &mut TsTypes) -> String {
        T::ts_type(types)
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.to_js(host)
    }
}

impl Ret for () {
    const UNIT: bool = true;

    fn ts_type(_types: &mut TsTypes) -> String {
        "void".into()
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        Ok(JsOwned::new(host, host.undefined()))
    }
}

impl<C: Class> Ret for Instance<C> {
    fn ts_type(types: &mut TsTypes) -> String {
        types.class(C::DEF)
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        Ok(JsOwned::new(host, host.wrap(self.erased())?))
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        out.push(C::DEF);
    }
}

/// An array of instances' objects.
impl<C: Class> Ret for Vec<Instance<C>> {
    fn ts_type(types: &mut TsTypes) -> String {
        format!("{}[]", types.class(C::DEF))
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        // Owned until the array takes them, as `Vec<T>`'s items are.
        let mut items = Vec::with_capacity(self.len());
        for instance in self {
            items.push(instance.into_js(host)?);
        }
        let raws = items.into_iter().map(JsOwned::into_raw).collect();
        Ok(JsOwned::new(host, host.new_array(raws)?))
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        out.push(C::DEF);
    }
}

impl<C: Class> Ret for Option<Instance<C>> {
    fn ts_type(types: &mut TsTypes) -> String {
        format!("{} | null", <Instance<C> as Ret>::ts_type(types))
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Some(i) => i.into_js(host),
            None => Ok(JsOwned::new(host, host.null())),
        }
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        out.push(C::DEF);
    }
}

// --- Specs ------------------------------------------------------------------------

/// One member, for the JS face and the declarations.
#[derive(Debug, Clone)]
pub struct MemberSpec {
    /// Its JS name.
    pub name: &'static str,
    /// Documentation.
    pub doc: &'static str,
    /// What it is.
    pub kind: MemberKind,
    /// Its parameters: JS name, TypeScript type, optional.
    pub params: Vec<(&'static str, String, bool)>,
    /// The TypeScript type of its result (`None`: nothing).
    pub returns: Option<String>,
    /// JS gets a promise.
    pub is_async: bool,
    /// The signatures TypeScript sees instead ([`Member::overloads`]).
    pub overloads: Vec<super::OverloadSpec>,
}

/// What a class is to JS and its declarations.
#[derive(Debug, Clone)]
pub struct ClassSpec {
    /// Its JS name.
    pub name: &'static str,
    /// Documentation.
    pub doc: &'static str,
    /// Its members.
    pub members: Vec<MemberSpec>,
    /// The named TypeScript types they use.
    pub types: TsTypes,
    /// The class itself.
    pub def: &'static ClassDef,
}

impl ClassSpec {
    pub(crate) fn of(def: &'static ClassDef) -> Self {
        let mut types = TsTypes::default();
        let members = def
            .members
            .iter()
            .map(|m| MemberSpec {
                name: m.name,
                doc: m.doc,
                kind: m.kind,
                params: m
                    .params
                    .iter()
                    .map(|(n, ts, optional)| (*n, ts(&mut types), *optional))
                    .collect(),
                returns: m.returns.map(|ts| ts(&mut types)),
                is_async: m.call.is_async(),
                overloads: m
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
            name: def.name,
            doc: def.doc,
            members,
            types,
            def,
        }
    }
}

// --- What `#[class]` and `#[module]` call -----------------------------------------

/// The generated code's helpers.
#[doc(hidden)]
pub(crate) mod __private {
    use super::*;

    /// `T`'s TypeScript type as a parameter, or nothing in builds without
    /// declarations.
    pub const fn arg_ts<T: Arg>() -> TsType {
        if crate::element::DECLARATIONS {
            T::ts_type
        } else {
            |_| String::new()
        }
    }

    /// The TypeScript type of `T`, a callback parameter whose function's
    /// arguments `#[args(..)]` names `names`; nothing in builds without
    /// declarations.
    pub fn named_arg_ts<T: crate::element::callback::NamedArgs>(
        types: &mut TsTypes,
        names: &[&str],
    ) -> String {
        if crate::element::DECLARATIONS {
            T::ts_named(types, names)
        } else {
            String::new()
        }
    }

    /// `T`'s TypeScript type as a result.
    pub const fn ret_ts<T: Ret>() -> TsType {
        if crate::element::DECLARATIONS {
            T::ts_type
        } else {
            |_| String::new()
        }
    }

    /// The class a struct's value makes a new instance of.
    pub fn class_into_js<C: Class>(value: C, host: &dyn JsHost) -> Result<JsOwned<'_>, PropError> {
        Instance::new(value).into_js(host)
    }

    /// `C`'s TypeScript type.
    pub fn class_ts<C: Class>(types: &mut TsTypes) -> String {
        types.class(C::DEF)
    }

    /// The classes parameter type `T` names.
    pub fn arg_classes<T: Arg>(out: &mut Vec<&'static ClassDef>) {
        T::classes(out);
    }

    /// The classes result type `T` names.
    pub fn ret_classes<T: Ret>(out: &mut Vec<&'static ClassDef>) {
        T::classes(out);
    }

    /// Class `C` itself (a struct's value as a result).
    pub fn class_refs<C: Class>(out: &mut Vec<&'static ClassDef>) {
        out.push(C::DEF);
    }

    /// Argument `i` of the call (`what`: `Tally.add`, `name`: `by`, for
    /// the error).
    pub fn arg<T: Arg>(host: &dyn JsHost, i: usize, what: &str, name: &str) -> Result<T, Thrown> {
        T::from_js(JsIn::new(host, host.arg(i)))
            .map_err(|e| Thrown::Type(format!("{what}: `{name}`: {e}")))
    }

    /// The instance `this` of the call is.
    pub fn this<C: Class>(host: &dyn JsHost, what: &str) -> Result<Instance<C>, Thrown> {
        host.instance(host.this())
            .and_then(Instance::of)
            .ok_or_else(|| {
                Thrown::Type(format!("{what}: Illegal invocation: not a {}", C::DEF.name))
            })
    }

    /// The value of `instance`, borrowed for a call.
    pub fn borrow<C: Class>(instance: &Instance<C>) -> Result<Ref<'_, C>, Thrown> {
        instance.borrow()
    }

    /// The value of `instance`, borrowed mutably for a call.
    pub fn borrow_mut<C: Class>(instance: &Instance<C>) -> Result<RefMut<'_, C>, Thrown> {
        instance.borrow_mut()
    }

    /// The value of `instance`, argument `name` of `what` (`Account.transfer`,
    /// `to`), borrowed for the call: its error names them, as a wrong
    /// argument's does (``Account.transfer: `to`: Account is disposed``).
    pub fn borrow_arg<'a, C: Class>(
        instance: &'a Instance<C>,
        what: &str,
        name: &str,
    ) -> Result<Ref<'a, C>, Thrown> {
        instance.borrow().map_err(|e| arg_error(e, what, name))
    }

    /// [`borrow_arg`], mutably.
    pub fn borrow_arg_mut<'a, C: Class>(
        instance: &'a Instance<C>,
        what: &str,
        name: &str,
    ) -> Result<RefMut<'a, C>, Thrown> {
        instance.borrow_mut().map_err(|e| arg_error(e, what, name))
    }

    /// `e`, an argument's error, after `what` and the argument's `name`.
    fn arg_error(e: Thrown, what: &str, name: &str) -> Thrown {
        match e {
            Thrown::Type(m) => Thrown::Type(format!("{what}: `{name}`: {m}")),
            Thrown::Range(m) => Thrown::Range(format!("{what}: `{name}`: {m}")),
            Thrown::Error(m) => Thrown::Error(format!("{what}: `{name}`: {m}")),
            Thrown::Fields(mut f) => {
                f.message = format!("{what}: `{name}`: {}", f.message);
                Thrown::Fields(f)
            }
        }
    }

    /// The result of a synchronous call as a JS value.
    pub fn ret<T: Ret>(host: &dyn JsHost, value: T) -> Result<JsRaw, Thrown> {
        value
            .into_js(host)
            .map(JsOwned::into_raw)
            .map_err(|e| Thrown::Error(e.0))
    }

    /// [`ret`] of a `Result`: an `Err` throws an `Error` with its message
    /// (a [`crate::element::JsError`] its class).
    pub fn ret_result<T: Ret, E: crate::element::IntoThrown>(
        host: &dyn JsHost,
        value: Result<T, E>,
    ) -> Result<JsRaw, Thrown> {
        match value {
            Ok(v) => ret(host, v),
            Err(e) => Err(e.into_thrown()),
        }
    }

    /// The task a synchronous call returned ([`crate::element::Later`]).
    pub fn start<T: Ret + 'static>(value: crate::element::Later<T>) -> Result<TaskStart, Thrown> {
        Ok(Box::new(move || value.into_future()))
    }

    /// [`start`] of a `Result`: an `Err` throws in the call.
    pub fn start_result<T: Ret + 'static, E: crate::element::IntoThrown>(
        value: Result<crate::element::Later<T>, E>,
    ) -> Result<TaskStart, Thrown> {
        value.map_err(E::into_thrown).and_then(start)
    }

    /// What the call can do beyond computing (a `cx: CallCx` parameter).
    pub fn call_cx(host: &dyn JsHost) -> crate::element::CallCx<'_> {
        crate::element::CallCx::new(host)
    }

    /// The VM the call comes from (a `sys: System` parameter).
    pub fn system(host: &dyn JsHost) -> crate::element::System {
        host.system()
    }

    /// The object a constructor makes for `value`.
    pub fn construct<C: Class>(host: &dyn JsHost, value: C) -> Result<JsRaw, Thrown> {
        host.construct(Instance::new(value).erased())
            .map_err(|e| Thrown::Error(e.0))
    }

    /// [`construct`] of a `Result`.
    pub fn construct_result<C: Class, E: crate::element::IntoThrown>(
        host: &dyn JsHost,
        value: Result<C, E>,
    ) -> Result<JsRaw, Thrown> {
        match value {
            Ok(v) => construct(host, v),
            Err(e) => Err(e.into_thrown()),
        }
    }

    /// The result of a call JS waits for, boxed for its reply.
    pub fn boxed<T: Ret + 'static>(value: T) -> JsResult {
        Ok(Box::new(value))
    }

    /// [`boxed`] of a `Result`: an `Err` rejects (a [`crate::element::JsError`]
    /// with its class and properties, any other error with its message).
    pub fn boxed_result<T: Ret + 'static, E: crate::element::IntoThrown>(
        value: Result<T, E>,
    ) -> JsResult {
        match value {
            Ok(v) => Ok(Box::new(v)),
            Err(e) => Err(e.into_thrown()),
        }
    }

    /// The documentation of a class (`#[class]` on its struct).
    #[diagnostic::on_unimplemented(
        message = "`{Self}` needs `#[class]` on its struct too",
        label = "a class's struct and its `impl` block both have `#[class]`"
    )]
    pub trait ClassDoc {
        /// The struct's doc comment.
        const DOC: &'static str;
        /// `#[class(interface)]`: [`super::ClassDef::interface`].
        const INTERFACE: bool;
    }

    /// The documentation of a module (`#[module]` on its struct, or the
    /// `#[component]` of its name).
    #[diagnostic::on_unimplemented(
        message = "`{Self}` needs `#[module]` on its struct too",
        label = "a module's struct and its `impl` block both have `#[module]` (the struct's doc comment documents it)"
    )]
    pub trait ModuleDoc {
        /// The struct's (or component function's) doc comment.
        const DOC: &'static str;
    }

    /// A field of a class's struct, traced when its type implements
    /// [`Trace`] (`#[class]` calls `(&&Field(&self.x)).trace_field(t)`: the
    /// method of `TraceField` applies to types that implement it, the one
    /// of `SkipField` to the others).
    pub struct Field<'a, T>(pub &'a T);

    /// Traces a field whose type implements [`Trace`].
    pub trait TraceField {
        /// Reports the field's callbacks.
        fn trace_field(&self, tracer: &mut Tracer<'_>);
    }

    impl<T: Trace> TraceField for &Field<'_, T> {
        fn trace_field(&self, tracer: &mut Tracer<'_>) {
            self.0.trace(tracer);
        }
    }

    /// Skips a field whose type does not implement [`Trace`].
    pub trait SkipField {
        /// Nothing.
        fn trace_field(&self, tracer: &mut Tracer<'_>);
    }

    impl<T> SkipField for Field<'_, T> {
        fn trace_field(&self, _tracer: &mut Tracer<'_>) {}
    }

    /// The `TypeId` of `T` (what a [`ClassDef`] tells types apart by).
    pub fn type_id<T: 'static>() -> TypeId {
        TypeId::of::<T>()
    }

    /// `T`'s Rust path.
    pub fn type_name<T: 'static>() -> &'static str {
        std::any::type_name::<T>()
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        element::{Registry, declarations},
        prelude::*,
    };

    /// A function the generated code must not call for `core::mem::drop`.
    #[allow(dead_code)]
    fn drop() {}

    /// A field configured out is not traced: its type need not exist.
    #[class]
    struct Configured {
        #[cfg(any())]
        gone: NoSuchType,
        kept: Option<Callback>,
    }

    #[class]
    impl Configured {}

    #[allow(dead_code)]
    fn configured() -> Configured {
        Configured { kept: None }
    }

    /// A tally kept in Rust.
    #[class]
    struct Tally {
        count: i64,
        label: Option<String>,
    }

    #[class]
    impl Tally {
        /// Starts at `start` (0 when left out).
        pub(crate) fn new(start: Option<i64>) -> Self {
            Tally {
                count: start.unwrap_or(0),
                label: None,
            }
        }

        /// Adds `by`; the new count.
        pub(crate) fn add(&mut self, by: i64, label: Option<String>) -> i64 {
            let _ = label;
            self.count += by;
            self.count
        }

        /// The count.
        #[getter]
        pub(crate) fn count(&self) -> i64 {
            self.count
        }

        #[setter]
        pub(crate) fn set_count(&mut self, count: i64) {
            self.count = count;
        }

        #[getter]
        pub(crate) fn label(&self) -> Option<String> {
            self.label.clone()
        }

        /// A setter's value is required, even an `Option`.
        #[setter]
        pub(crate) fn set_label(&mut self, label: Option<String>) {
            self.label = label;
        }

        /// Only where it is compiled.
        #[cfg(any())]
        pub(crate) fn nowhere(&self) -> i64 {
            0
        }

        /// A tally from `"12"`; throws on anything else.
        pub(crate) fn parse(text: String) -> Result<Tally, String> {
            text.parse()
                .map(|count| Tally { count, label: None })
                .map_err(|_| text)
        }

        pub(crate) fn reset(&mut self, to: Option<i64>, by: i64) {
            self.count = to.unwrap_or(0) + by;
        }

        pub(crate) fn absorb(
            &mut self,
            other: &Tally,
            token: Option<Instance<Token>>,
        ) -> Instance<Token> {
            self.count += other.count;
            token.unwrap_or_else(|| Instance::new(Token))
        }

        /// Saves the count; resolves when it is written.
        pub(crate) async fn save(this: Instance<Self>, path: String) -> Result<(), String> {
            let _ = (this, path);
            Ok(())
        }

        pub(crate) async fn later(start: i64) -> Tally {
            Tally {
                count: start,
                label: None,
            }
        }

        /// Sorts with the app's comparison.
        pub(crate) fn sort_by(&mut self, compare: Callback<(String, String), f64>) {
            let _ = compare;
        }

        pub(crate) fn on(
            &mut self,
            #[args(count)] listener: Option<Callback<i64>>,
            done: Option<Callback>,
        ) {
            let _ = (listener, done);
        }

        /// A helper without `pub`: Rust's only, not in TS.
        #[allow(dead_code)]
        fn bump(&mut self) {
            self.count += 1;
        }

        /// A private associated function: not a static in TS either.
        #[allow(dead_code)]
        async fn private_later() -> i64 {
            0
        }
    }

    /// Made by its members only.
    #[class]
    struct Token;

    #[class]
    impl Token {
        pub(crate) fn mint() -> Token {
            Token
        }
    }

    #[test]
    fn classes_are_declared_from_their_definitions() {
        let mut registry = Registry::ui_set("test/ui");
        registry.class::<Tally>().class::<Token>();
        // Helpers without `pub` stay Rust's: neither declared nor members.
        assert!(
            !<Tally as crate::element::Class>::DEF
                .members
                .iter()
                .any(|m| m.name == "bump" || m.name == "privateLater")
        );
        assert_eq!(
            declarations(&registry, &[]),
            r#"/** A tally kept in Rust. */
export declare class Tally {
  /** Starts at `start` (0 when left out). */
  constructor(start?: number | null);
  /** Adds `by`; the new count. */
  add(by: number, label?: string | null): number;
  /** The count. */
  get count(): number;
  set count(count: number);
  get label(): string | null;
  /** A setter's value is required, even an `Option`. */
  set label(label: string | null);
  /** A tally from `"12"`; throws on anything else. */
  static parse(text: string): Tally;
  reset(to: number | null, by: number): void;
  absorb(other: Tally, token?: Token | null): Token;
  /** Saves the count; resolves when it is written. */
  save(path: string): Promise<void>;
  static later(start: number): Promise<Tally>;
  /** Sorts with the app's comparison. */
  sortBy(compare: (a: string, b: string) => number): void;
  on(listener?: ((count: number) => void) | null, done?: (() => void) | null): void;
  /** Frees the Rust value now (else when the object is collected); the object throws after. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Made by its members only. */
export declare class Token {
  /** Made by the class's members only. */
  private constructor();
  static mint(): Token;
  /** Frees the Rust value now (else when the object is collected); the object throws after. */
  dispose(): void;
  [Symbol.dispose](): void;
}

"#
        );
    }

    /// Functions of the three kinds.
    #[module]
    struct Tools;

    #[module]
    impl Tools {
        /// The sum, at once.
        pub(crate) fn sum(values: Vec<f64>) -> f64 {
            values.iter().sum()
        }

        pub(crate) fn shout(text: String) {
            let _ = text;
        }

        /// A promise of the length.
        pub(crate) fn measure(text: String, cx: &mut ModuleCx) -> usize {
            let _ = cx;
            text.len()
        }

        /// Picks with the app's choice, its arguments named.
        pub(crate) fn pick(#[args(old_value, new_value)] choose: Callback<(f64, f64), f64>) -> f64 {
            choose.call((0.0, 1.0)).unwrap_or(0.0)
        }

        /// An op returning nothing: a plain call.
        pub(crate) fn beep(cx: &mut ModuleCx) {
            let _ = cx;
        }

        /// An op that may fail: a promise, rejected with an `Err`.
        pub(crate) fn check(cx: &mut ModuleCx) -> Result<(), String> {
            let _ = cx;
            Ok(())
        }

        /// `-> ()` written out: the same as no return type.
        #[allow(clippy::unused_unit)]
        pub(crate) fn hum(cx: &mut ModuleCx) -> () {
            let _ = cx;
        }

        /// A task returning nothing.
        pub(crate) async fn settle() {}

        pub(crate) async fn later(listener: Callback<i64, String>) -> Result<String, String> {
            listener.call_async(1).await
        }

        /// Only where it is compiled.
        #[cfg(any())]
        pub(crate) fn nowhere() {}

        /// A helper without `pub`: not exported.
        #[allow(dead_code)]
        fn helper(text: String) -> String {
            text
        }
    }

    #[test]
    fn functions_without_a_context_return_their_values() {
        let mut registry = Registry::ui_set("test/ui");
        registry.module::<Tools>();
        assert!(
            !<Tools as crate::element::Module>::FUNCTIONS
                .iter()
                .any(|f| f.name == "helper")
        );
        assert_eq!(
            declarations(&registry, &[]),
            r#"/** Functions of the three kinds. */
export interface ToolsModule {
  /** The sum, at once. */
  sum(values: (number)[]): number;
  shout(text: string): void;
  /** A promise of the length. */
  measure(text: string): Promise<number>;
  /** Picks with the app's choice, its arguments named. */
  pick(choose: (oldValue: number, newValue: number) => number): number;
  /** An op returning nothing: a plain call. */
  beep(): void;
  /** An op that may fail: a promise, rejected with an `Err`. */
  check(): Promise<void>;
  /** `-> ()` written out: the same as no return type. */
  hum(): void;
  /** A task returning nothing. */
  settle(): Promise<void>;
  later(listener: (value: number) => string): Promise<string>;
}

/** Functions of the three kinds. */
export declare const Tools: ToolsModule;

"#
        );
    }

    /// A signature naming a class registers it too: registering it again
    /// does nothing.
    #[test]
    fn registering_a_class_again_does_nothing() {
        let mut r = Registry::ui_set("test/ui");
        r.class::<Tally>().class::<Tally>();
        let tallies = r.class_specs().iter().filter(|c| c.name == "Tally").count();
        assert_eq!(tallies, 1);
    }

    /// A component exported as `Tally`.
    mod view {
        use crate::prelude::*;

        pub(super) struct Tally;

        impl Component for Tally {
            type Props = ();
            type Event = NoEvent;

            fn view(_: (), _: Scope<NoEvent>) -> impl IntoElement {
                view()
            }
        }
    }

    /// A class and a component of one name clash, whichever comes first.
    #[test]
    fn a_class_and_a_component_share_no_name() {
        let class_first = std::panic::catch_unwind(|| {
            Registry::ui_set("test/ui")
                .class::<Tally>()
                .register::<view::Tally>();
        });
        assert!(class_first.is_err(), "a component after a class");
        let component_first = std::panic::catch_unwind(|| {
            Registry::ui_set("test/ui")
                .register::<view::Tally>()
                .class::<Tally>();
        });
        assert!(component_first.is_err(), "a class after a component");
    }
}
