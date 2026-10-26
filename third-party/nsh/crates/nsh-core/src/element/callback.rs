//! JS functions Rust takes ([`Callback`]): called on the spot inside a
//! synchronous call from JS, or queued for the next JS turn from anywhere
//! on the engine thread ([`Callback::post`], [`Callback::call_async`]: the
//! engine hands the queue, [`super::Posts`], to the script after the
//! core's work). A callback an instance keeps is reported to QuickJS's
//! collector through the class's [`Trace`], so a cycle through the
//! instance's JS object is collected.

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap, VecDeque},
    fmt,
    marker::PhantomData,
    rc::Rc,
};

use super::{
    JsValue, PropError, TsTypes,
    class::{Arg, Class, ClassDef, Instance, Ret},
    js::{JsHost, JsIn, JsOwned},
    task::Answer,
};

/// A JS function as Rust keeps it (`nsh-js` implements it).
#[doc(hidden)]
pub trait CallbackHandle: std::any::Any {
    /// Runs `call` now: inside a synchronous call from JS.
    ///
    /// # Panics
    ///
    /// Outside one (in a task): JS is not running there.
    fn call_now(&self, call: JsCall);
    /// Queues `call` for the next JS turn.
    fn post(&self, call: JsCall);
    /// The value it keeps, as an owned value of `host` (a new reference the
    /// caller frees); `None` once the VM is gone.
    fn value(&self, _host: &dyn JsHost) -> Option<super::JsRaw> {
        None
    }
}

type ArgsFn = Box<dyn for<'a> FnOnce(&'a dyn JsHost) -> Result<Vec<JsOwned<'a>>, PropError>>;
type ReplyFn = Box<dyn for<'a> FnOnce(Result<JsIn<'a>, Exception>)>;

/// What a JS function threw ([`Callback::call_async_traced`]): its message
/// and, for an `Error`, the stack where it was made (`    at f
/// (bundle.js:12:5)` lines, the bundle's positions).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exception {
    /// The message (an `Error`'s `message`, else the value as a string).
    pub message: String,
    /// The stack, for an `Error`.
    pub stack: Option<String>,
}

impl From<String> for Exception {
    fn from(message: String) -> Self {
        Self {
            message,
            stack: None,
        }
    }
}

impl fmt::Display for Exception {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// A call of a JS function: its arguments, made when it runs, and what
/// receives its result.
#[doc(hidden)]
pub struct JsCall {
    callback: Rc<dyn CallbackHandle>,
    args: Option<ArgsFn>,
    reply: Option<ReplyFn>,
    /// The reply waits for a promise the function returns.
    settles: bool,
}

impl JsCall {
    fn new<A: CallbackArgs + 'static>(
        callback: Rc<dyn CallbackHandle>,
        args: A,
        reply: Option<ReplyFn>,
        settles: bool,
    ) -> Self {
        Self {
            callback,
            args: Some(Box::new(move |host| args.into_js_args(host))),
            reply,
            settles,
        }
    }

    /// The function to call.
    pub fn callback(&self) -> &Rc<dyn CallbackHandle> {
        &self.callback
    }

    /// The arguments, as values of `host`.
    pub fn args<'a>(&mut self, host: &'a dyn JsHost) -> Result<Vec<JsOwned<'a>>, PropError> {
        match self.args.take() {
            Some(args) => args(host),
            None => Ok(Vec::new()),
        }
    }

    /// Whether the result is wanted (`call`, `call_async`).
    pub fn wants_reply(&self) -> bool {
        self.reply.is_some()
    }

    /// Whether the reply waits for a promise the function returns
    /// (`call_async`).
    pub fn settles(&self) -> bool {
        self.settles
    }

    /// Delivers the result (or what the function threw).
    pub fn reply(mut self, result: Result<JsIn<'_>, Exception>) {
        if let Some(reply) = self.reply.take() {
            reply(result);
        }
    }
}

impl Drop for JsCall {
    fn drop(&mut self) {
        if let Some(reply) = self.reply.take() {
            reply(Err("the JS function was not called (JS stopped)"
                .to_owned()
                .into()));
        }
    }
}

impl fmt::Debug for JsCall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JsCall")
            .field("reply", &self.reply.is_some())
            .finish_non_exhaustive()
    }
}

/// A JS function a class's member or a function takes (TS:
/// `Callback<f64>` is `(value: number) => void`, `Callback<(String, f64),
/// bool>` is `(a: string, b: number) => boolean`; `#[args(name, amount)]`
/// on the parameter names them, `(name: string, amount: number) =>
/// boolean`):
/// `A` is its argument (a [`JsValue`] type, an instance, a tuple of them
/// for several, `()` for none), `R` what it returns. Cheap to clone; the JS
/// function is released when the last clone goes. Kept in an instance's
/// field, it is reported to QuickJS's collector, so a cycle through the
/// instance's JS object is collected; kept elsewhere, it keeps the
/// function alive until dropped.
pub struct Callback<A = (), R = ()> {
    handle: Rc<dyn CallbackHandle>,
    _types: PhantomData<fn(A) -> R>,
}

impl<A, R> Clone for Callback<A, R> {
    fn clone(&self) -> Self {
        Self {
            handle: self.handle.clone(),
            _types: PhantomData,
        }
    }
}

impl<A, R> fmt::Debug for Callback<A, R> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Callback")
    }
}

impl<A, R> Callback<A, R> {
    /// The JS function it keeps (two callbacks of one function share it).
    pub(crate) fn handle(&self) -> &Rc<dyn CallbackHandle> {
        &self.handle
    }
}

impl<A: CallbackArgs + 'static, R: CallbackRet + 'static> Callback<A, R> {
    fn of(handle: Rc<dyn CallbackHandle>) -> Self {
        Self {
            handle,
            _types: PhantomData,
        }
    }

    /// Calls the function now, inside a synchronous call from JS (a
    /// method, a function, the constructor), as `Array.prototype.sort`
    /// calls its comparison: its result, or what it threw (its message).
    /// The instance the call is on stays borrowed meanwhile: the function
    /// using it again throws.
    ///
    /// # Panics
    ///
    /// Outside a synchronous call from JS (in a task): use
    /// [`Callback::post`] or [`Callback::call_async`] there.
    pub fn call(&self, args: A) -> Result<R, String> {
        let out: Rc<RefCell<Option<Result<R, String>>>> = Rc::default();
        let slot = out.clone();
        let call = JsCall::new(
            self.handle.clone(),
            args,
            Some(Box::new(move |result| {
                *slot.borrow_mut() = Some(
                    result
                        .map_err(|e| e.message)
                        .and_then(|v| R::from_js(v).map_err(|e| e.0)),
                );
            })),
            false,
        );
        self.handle.call_now(call);
        let result = out.borrow_mut().take();
        result.unwrap_or_else(|| Err("the JS function was not called".to_owned()))
    }

    /// Calls the function in the next JS turn, in order with the other
    /// posts, forgetting its result (what it throws is reported as
    /// uncaught). From anywhere on the engine thread.
    pub fn post(&self, args: A) {
        self.handle
            .post(JsCall::new(self.handle.clone(), args, None, false));
    }

    /// Calls the function in the next JS turn: its result (a promise it
    /// returns, settled), or the message of what it threw.
    pub fn call_async(&self, args: A) -> Answer<Result<R, String>> {
        let (answer, slot) = Answer::new();
        self.handle.post(JsCall::new(
            self.handle.clone(),
            args,
            Some(Box::new(move |result| {
                let value = result
                    .map_err(|e| e.message)
                    .and_then(|v| R::from_js(v).map_err(|e| e.0));
                slot.borrow_mut().deliver(value);
            })),
            true,
        ));
        answer
    }

    /// [`Callback::call_async`], with what the function threw (or its
    /// promise rejected with) whole: the message and the stack, which says
    /// where it was thrown (a test's failing line).
    pub fn call_async_traced(&self, args: A) -> Answer<Result<R, Exception>> {
        let (answer, slot) = Answer::new();
        self.handle.post(JsCall::new(
            self.handle.clone(),
            args,
            Some(Box::new(move |result| {
                let value = result.and_then(|v| R::from_js(v).map_err(|e| e.0.into()));
                slot.borrow_mut().deliver(value);
            })),
            true,
        ));
        answer
    }
}

/// The arguments of a [`Callback`]: one value, `()` for none, or a tuple.
pub trait CallbackArgs {
    /// How many there are.
    const ARITY: usize;

    /// Its TypeScript parameters, named `names` (`name: string, amount:
    /// number`), or without names `value` for one and `a`, `b`, ... for
    /// several.
    fn ts_params(types: &mut TsTypes, names: &[&str]) -> String;
    /// The arguments as JS values.
    fn into_js_args<'a>(self, host: &'a dyn JsHost) -> Result<Vec<JsOwned<'a>>, PropError>;
    /// Adds the classes the arguments name.
    #[doc(hidden)]
    fn classes(out: &mut Vec<&'static ClassDef>);
}

impl<T: Ret> CallbackArgs for T {
    const ARITY: usize = if T::UNIT { 0 } else { 1 };

    fn ts_params(types: &mut TsTypes, names: &[&str]) -> String {
        if T::UNIT {
            String::new()
        } else {
            format!(
                "{}: {}",
                names.first().copied().unwrap_or("value"),
                T::ts_type(types)
            )
        }
    }

    fn into_js_args<'a>(self, host: &'a dyn JsHost) -> Result<Vec<JsOwned<'a>>, PropError> {
        if T::UNIT {
            Ok(Vec::new())
        } else {
            Ok(vec![Ret::into_js(self, host)?])
        }
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        T::classes(out);
    }
}

macro_rules! callback_tuple {
    ($(($($t:ident $v:ident $n:literal $i:literal),*)),*) => {$(
        impl<$($t: Ret),*> CallbackArgs for ($($t,)*) {
            const ARITY: usize = [$($n),*].len();

            fn ts_params(types: &mut TsTypes, names: &[&str]) -> String {
                let defaults = [$($n),*];
                [$($t::ts_type(types)),*]
                    .iter()
                    .enumerate()
                    .map(|(i, ts)| format!("{}: {ts}", names.get(i).copied().unwrap_or(defaults[i])))
                    .collect::<Vec<_>>()
                    .join(", ")
            }

            fn into_js_args<'a>(self, host: &'a dyn JsHost) -> Result<Vec<JsOwned<'a>>, PropError> {
                let ($($v,)*) = self;
                Ok(vec![$(Ret::into_js($v, host)?),*])
            }

            fn classes(out: &mut Vec<&'static ClassDef>) {
                $($t::classes(out);)*
            }
        }
    )*};
}

callback_tuple!(
    (A a "a" 0, B b "b" 1),
    (A a "a" 0, B b "b" 1, C c "c" 2),
    (A a "a" 0, B b "b" 1, C c "c" 2, D d "d" 3)
);

/// What a [`Callback`] returns: a [`JsValue`] type, or `()` (its result
/// ignored).
pub trait CallbackRet: Sized {
    /// Its TypeScript type.
    fn ts_type(types: &mut TsTypes) -> String;
    /// The value the function returned.
    fn from_js(value: JsIn<'_>) -> Result<Self, PropError>;
}

impl<T: JsValue> CallbackRet for T {
    fn ts_type(types: &mut TsTypes) -> String {
        T::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        T::from_js(value)
    }
}

impl CallbackRet for () {
    fn ts_type(_types: &mut TsTypes) -> String {
        "void".into()
    }

    fn from_js(_value: JsIn<'_>) -> Result<Self, PropError> {
        Ok(())
    }
}

/// The TypeScript type of a callback whose arguments are named `names`
/// (none: the defaults): `(value: string) => void`.
fn callback_ts<A: CallbackArgs, R: CallbackRet>(types: &mut TsTypes, names: &[&str]) -> String {
    format!("({}) => {}", A::ts_params(types, names), R::ts_type(types))
}

/// A parameter whose JS function's arguments `#[args(..)]` names: a
/// [`Callback`], or an `Option` of one.
#[doc(hidden)]
#[diagnostic::on_unimplemented(
    message = "`#[args(..)]` names the arguments of a `Callback`: `{Self}` is not one",
    label = "`#[args(..)]` is for a `Callback<A, R>` parameter (or an `Option` of one)"
)]
pub trait NamedArgs {
    /// How many arguments the function takes.
    const ARITY: usize;
    /// The parameter's TypeScript type, its function's arguments named
    /// `names`.
    fn ts_named(types: &mut TsTypes, names: &[&str]) -> String;
}

impl<A: CallbackArgs + 'static, R: CallbackRet + 'static> NamedArgs for Callback<A, R> {
    const ARITY: usize = A::ARITY;

    fn ts_named(types: &mut TsTypes, names: &[&str]) -> String {
        callback_ts::<A, R>(types, names)
    }
}

impl<A: CallbackArgs + 'static, R: CallbackRet + 'static> NamedArgs for Option<Callback<A, R>> {
    const ARITY: usize = A::ARITY;

    fn ts_named(types: &mut TsTypes, names: &[&str]) -> String {
        format!("({}) | null", callback_ts::<A, R>(types, names))
    }
}

impl<A: CallbackArgs + 'static, R: CallbackRet + 'static> Arg for Callback<A, R> {
    fn ts_type(types: &mut TsTypes) -> String {
        callback_ts::<A, R>(types, &[])
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        value
            .host()
            .callback(value.raw())
            .map(Callback::of)
            .ok_or_else(|| value.expected("a function"))
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        A::classes(out);
    }
}

/// `null` or `undefined` is `None`.
impl<A: CallbackArgs + 'static, R: CallbackRet + 'static> Arg for Option<Callback<A, R>> {
    fn ts_type(types: &mut TsTypes) -> String {
        format!("({}) | null", callback_ts::<A, R>(types, &[]))
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.is_nullish() {
            return Ok(None);
        }
        Callback::from_js(value).map(Some)
    }

    fn classes(out: &mut Vec<&'static ClassDef>) {
        A::classes(out);
    }
}

// --- Tracing ----------------------------------------------------------------------

/// Where a class reports the callbacks its value keeps, for QuickJS's
/// collector: a callback whose function reaches the instance's own JS
/// object would keep both alive forever otherwise.
pub struct Tracer<'a> {
    mark: &'a mut dyn FnMut(&dyn CallbackHandle),
}

impl<'a> Tracer<'a> {
    /// Reports callbacks to `mark`.
    #[doc(hidden)]
    pub fn new(mark: &'a mut dyn FnMut(&dyn CallbackHandle)) -> Self {
        Self { mark }
    }
}

impl fmt::Debug for Tracer<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Tracer")
    }
}

/// What reports the callbacks a value keeps, for QuickJS's collector.
/// `#[class]` on a struct implements it from the fields whose types
/// implement it (`Callback`, `Instance`, and `Option`, `Box`, `RefCell`,
/// `Vec`, `VecDeque`, `HashMap` / `BTreeMap` values and pairs of them);
/// other fields are not reported, which is always safe: what they keep
/// stays alive while they do.
///
/// # Safety
///
/// The collector counts each reported function as one reference held by
/// the instance's JS object. An implementation reports, on each call, a
/// callback at most once, and only one held through this value alone (no
/// other value or clone keeps it, as the impls of `Callback` and
/// `Instance` check with their strong counts): reporting one twice, or one
/// shared (an `Rc` reached from two instances), lets the collector free a
/// function still in use. It never panics, allocates JS values or runs
/// JS: it is called from the collector's mark phase, which a panic would
/// leave half done (the runtime catches one and logs it, and what was not
/// reported stays alive, but a panic midway may already have reported part
/// of a value). It reads only, without borrowing what the app may hold
/// borrowed (`RefCell::try_borrow`: a value borrowed elsewhere is
/// skipped).
pub unsafe trait Trace {
    /// Reports the callbacks to `tracer`.
    fn trace(&self, tracer: &mut Tracer<'_>);
}

/// A callback held only here: shared ones are kept alive by whoever else
/// holds them (reporting those would let the collector free a function
/// still in use).
unsafe impl<A, R> Trace for Callback<A, R> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if Rc::strong_count(&self.handle) == 1 {
            (tracer.mark)(&*self.handle);
        }
    }
}

/// An instance held only here: the callbacks its value keeps.
unsafe impl<C: Class> Trace for Instance<C> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if self.only_handle() {
            self.trace_value(tracer);
        }
    }
}

unsafe impl<T: Trace> Trace for Option<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(v) = self {
            v.trace(tracer);
        }
    }
}

unsafe impl<T: Trace> Trace for Box<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        (**self).trace(tracer);
    }
}

unsafe impl<T: Trace> Trace for RefCell<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Ok(v) = self.try_borrow() {
            v.trace(tracer);
        }
    }
}

unsafe impl<T: Trace> Trace for Vec<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for v in self {
            v.trace(tracer);
        }
    }
}

unsafe impl<T: Trace> Trace for VecDeque<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for v in self {
            v.trace(tracer);
        }
    }
}

unsafe impl<K, T: Trace, S> Trace for HashMap<K, T, S> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for v in self.values() {
            v.trace(tracer);
        }
    }
}

unsafe impl<K, T: Trace> Trace for BTreeMap<K, T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for v in self.values() {
            v.trace(tracer);
        }
    }
}

unsafe impl<A: Trace, B: Trace> Trace for (A, B) {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        self.0.trace(tracer);
        self.1.trace(tracer);
    }
}
