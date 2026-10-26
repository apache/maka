//! The web platform APIs of TS apps, natively: events and abort signals,
//! URLs, text encoding, blobs and form data, streams, and `fetch` with its
//! `Headers`, `Request` and `Response`; and ECMAScript's `Intl`, which
//! QuickJS lacks (`intl/`). They are JS globals only: Rust code uses
//! crates of its choice.
//!
//! Every object of these classes is one QuickJS class (functions made in
//! Rust, [`js::closure`], another, callable one) whose opaque is the Rust
//! data of its interface ([`Object`]) in a `RefCell`: code borrows it
//! briefly and never across a call into JS, so a re-entrant call throws
//! instead of aliasing. Constructors honor `new.target`, so the classes can
//! be subclassed (`class Channel extends EventTarget`). The classes are
//! made when an app first reads one of the globals. The objects of Rust's
//! `#[class]` classes (`classes.rs`) are of the same QuickJS class.

pub(crate) mod js;

pub(crate) mod blob;
mod encoding;
mod event;
mod fetch;
mod intl;
mod iterator;
mod streams;
mod url;
mod websocket;

use std::{
    any::Any,
    cell::{RefCell, RefMut},
    ffi::{CStr, c_int, c_void},
    ptr,
};

use js::{Args, Closure, Ctx, Native, R, Raw, Throw, Trace, UNDEFINED, V};
use rquickjs::qjs;

/// The Rust data of an object of a web class.
pub(crate) trait Object: Trace + Any {
    /// The `EventTarget` part (for `EventTarget`'s methods on subclasses).
    fn target(&mut self) -> Option<&mut event::Target> {
        None
    }

    /// The `Blob` part (`File`s).
    fn blob(&mut self) -> Option<&mut blob::Blob> {
        None
    }

    /// The body (`Request`, `Response`).
    fn body(&mut self) -> Option<&mut fetch::Body> {
        None
    }
}

/// The classes, in registration order (parents first).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(usize)]
pub(crate) enum Class {
    EventTarget,
    Event,
    CustomEvent,
    AbortSignal,
    AbortController,
    Iterator,
    UrlSearchParams,
    Url,
    TextEncoder,
    TextDecoder,
    Blob,
    File,
    FormData,
    ByteLengthQueuingStrategy,
    CountQueuingStrategy,
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
    ReadableStreamDefaultController,
    ReadableByteStreamController,
    ReadableStreamBYOBRequest,
    ReadableStreamAsyncIterator,
    Internal,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    TransformStream,
    TransformStreamDefaultController,
    TextEncoderStream,
    TextDecoderStream,
    Headers,
    Request,
    Response,
    WebSocket,
    NumberFormat,
    DateTimeFormat,
}

const CLASS_COUNT: usize = Class::DateTimeFormat as usize + 1;

/// A method key: a name or a well-known symbol.
pub(crate) enum Key {
    Name(&'static CStr),
    Iterator,
    AsyncIterator,
}

/// A class: its constructor, prototype members and static members.
pub(crate) struct Spec {
    pub(crate) class: Class,
    pub(crate) name: &'static CStr,
    pub(crate) parent: Option<Class>,
    /// `None`: an illegal constructor (objects are made internally).
    pub(crate) constructor: Option<(Native, c_int)>,
    pub(crate) methods: &'static [(Key, Native, c_int)],
    /// Accessors: getter and optional setter.
    pub(crate) accessors: &'static [(&'static CStr, Native, Option<Native>)],
    pub(crate) statics: &'static [(&'static CStr, Native, c_int)],
    /// Constants on the constructor and the prototype.
    pub(crate) constants: &'static [(&'static CStr, f64)],
    /// Defined on the global object.
    pub(crate) global: bool,
    /// Its TypeScript declaration (`globals.d.ts`).
    pub(crate) ts: ClassTs,
}

/// The TypeScript declaration of a global class: `declare class
/// <name><head> { <members> }`, with its constants (`readonly NONE:
/// number`) added from the spec. A test checks that the members are the
/// spec's.
pub(crate) struct ClassTs {
    /// Documentation (plain text).
    pub(crate) doc: &'static str,
    /// What follows the name: type parameters and heritage (`<R = any>`,
    /// ` extends EventTarget`).
    pub(crate) head: &'static str,
    /// The members' declarations, one per line as in a class body.
    pub(crate) members: &'static str,
}

impl ClassTs {
    /// Not declared: a class apps never name (`Iterator`'s prototype, the
    /// streams' internals).
    pub(crate) const NONE: ClassTs = ClassTs {
        doc: "",
        head: "",
        members: "",
    };

    /// This declaration, or [`ClassTs::NONE`] in builds without
    /// declarations (`nsh_core::element::DECLARATIONS`): the text is then not in
    /// the binary.
    pub(crate) const fn declared(self) -> ClassTs {
        if nsh_core::element::DECLARATIONS {
            self
        } else {
            ClassTs::NONE
        }
    }
}

fn specs() -> impl Iterator<Item = &'static Spec> {
    [
        event::SPECS,
        iterator::SPECS,
        url::SPECS,
        encoding::SPECS,
        blob::SPECS,
        fetch::SPECS,
        websocket::SPECS,
        intl::SPECS,
    ]
    .into_iter()
    .flatten()
    .chain(streams::specs())
}

/// A global function (not a class) and its declaration.
pub(crate) struct Function {
    pub(crate) name: &'static CStr,
    pub(crate) native: Native,
    pub(crate) length: c_int,
    /// Documentation (plain text).
    pub(crate) doc: &'static str,
    /// What follows the name in its declaration.
    pub(crate) signature: &'static str,
}

/// Global functions (not classes).
pub(crate) fn functions() -> impl Iterator<Item = &'static Function> {
    fetch::FUNCTIONS.iter()
}

/// The global classes, as declared.
pub(crate) fn declared_specs() -> impl Iterator<Item = &'static Spec> {
    specs().filter(|s| s.global)
}

/// The classes apps never name.
#[cfg(test)]
pub(crate) fn internal_specs() -> impl Iterator<Item = &'static Spec> {
    specs().filter(|s| !s.global)
}

/// The TypeScript types the classes use (`BodyInit`, `EventInit`, ...).
pub(crate) const TYPES: &[&str] = &[
    encoding::TYPES,
    event::TYPES,
    blob::TYPES,
    streams::TYPES,
    streams::readable::TYPES,
    streams::writable::TYPES,
    streams::transform::TYPES,
    fetch::TYPES,
    websocket::TYPES,
];

/// The per-context state: the classes and the prototypes.
#[derive(Default)]
pub(crate) struct Web {
    object_class: qjs::JSClassID,
    closure_class: qjs::JSClassID,
    built: bool,
    /// By [`Class`]: prototype and constructor.
    protos: Vec<V>,
    ctors: Vec<V>,
    /// The intrinsic `Promise.prototype.then`.
    then: V,
    pub(crate) blob_urls: blob::BlobUrls,
    /// Functions that are one per context (the strategies' `size`).
    cached: Vec<V>,
    /// The requests in flight.
    pub(crate) fetches: rustc_hash::FxHashMap<crate::net::RequestId, fetch::Inflight>,
    pub(crate) next_fetch: crate::net::RequestId,
    /// What relative request URLs resolve against ([`crate::HostOptions`]
    /// `base_url`).
    pub(crate) base_url: Option<::url::Url>,
    /// The intrinsic `Date`, under a manual clock (`crate::clock`).
    pub(crate) date: V,
    /// When `performance.now()` is 0 under a manual clock.
    pub(crate) clock_origin: Option<nsh_core::time::Instant>,
}

impl Web {
    /// Frees the values held (the state is unregistered).
    pub(crate) fn free_all(&mut self) {
        self.protos.clear();
        self.ctors.clear();
        self.then = V::undefined();
        self.blob_urls = Default::default();
        self.cached.clear();
        self.fetches.clear();
        self.date = V::undefined();
    }
}

pub(crate) fn web<'a>(cx: Ctx) -> &'a mut Web {
    // SAFETY: a projection of the state's field; callers hold it briefly
    // and never across JS.
    unsafe { &mut (*crate::state::state(cx)).web }
}

/// What an object's opaque points to.
struct Slot(RefCell<Box<dyn Object>>);

thread_local! {
    /// The finalizers running on this thread: in a collection, or freeing
    /// an object whose last reference went (any release of a JS value may
    /// run one). No JS may run and no op be made until they return.
    static FINALIZING: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Raised while a finalizer of this thread drops Rust values (a Rust
/// class's value, a closure's captures): their drops are the app's code,
/// and what they do with JS waits ([`finalizing`]).
pub(crate) struct Finalizing(());

impl Finalizing {
    pub(crate) fn enter() -> Self {
        FINALIZING.with(|f| f.set(f.get() + 1));
        Finalizing(())
    }
}

impl Drop for Finalizing {
    fn drop(&mut self) {
        FINALIZING.with(|f| f.set(f.get() - 1));
    }
}

/// Whether a finalizer of this thread is dropping Rust values: a callback
/// must not run JS now (QuickJS is collecting garbage), and a post must
/// not make an op.
pub(crate) fn finalizing() -> bool {
    FINALIZING.with(|f| f.get() > 0)
}

unsafe extern "C" fn finalize(_rt: *mut qjs::JSRuntime, obj: Raw) {
    let _finalizing = Finalizing::enter();
    // SAFETY: the opaque of these classes is a boxed slot; its values free
    // themselves through the runtime.
    let slot = unsafe {
        let p = qjs::JS_GetAnyOpaque(obj, &mut 0);
        (!p.is_null()).then(|| Box::from_raw(p as *mut Slot))
    };
    // A Rust class's value drops here: a panic in the app's drop must not
    // unwind into the collector.
    if let Some(slot) = slot
        && std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(slot))).is_err()
    {
        log::error!(target: "js", "a value of a Rust class panicked while it was dropped");
    }
}

unsafe extern "C" fn mark(rt: *mut qjs::JSRuntime, obj: Raw, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer. A slot borrowed while the collector runs
    // (code allocating mid-borrow) is skipped for the whole run: unmarked
    // values only stay alive.
    unsafe {
        let p = qjs::JS_GetAnyOpaque(obj, &mut 0) as *const Slot;
        if let Some(slot) = p.as_ref()
            && let Ok(data) = slot.0.try_borrow()
        {
            // A Rust class's tracing is the app's code: a panic must not
            // unwind into the collector (what it did not mark stays alive).
            let traced = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                data.trace(&mut |v| qjs::JS_MarkValue(rt, v, mark));
            }));
            if traced.is_err() {
                log::error!(target: "js", "a value of a Rust class panicked while it was traced");
            }
        }
    }
}

unsafe extern "C" fn finalize_closure(_rt: *mut qjs::JSRuntime, obj: Raw) {
    let _finalizing = Finalizing::enter();
    // SAFETY: the opaque of closures is a boxed closure.
    let closure = unsafe {
        let p = qjs::JS_GetAnyOpaque(obj, &mut 0);
        (!p.is_null()).then(|| Box::from_raw(p as *mut Closure))
    };
    // Its captures may hold the app's values (a call's reply): a panic in
    // their drop must not unwind into the collector.
    if let Some(closure) = closure
        && std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(closure))).is_err()
    {
        log::error!(target: "js", "a Rust value a JS function held panicked while it was dropped");
    }
}

unsafe extern "C" fn mark_closure(rt: *mut qjs::JSRuntime, obj: Raw, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer.
    unsafe {
        let p = qjs::JS_GetAnyOpaque(obj, &mut 0) as *const Closure;
        if let Some(c) = p.as_ref() {
            c.trace(&mut |v| qjs::JS_MarkValue(rt, v, mark));
        }
    }
}

unsafe extern "C" fn call_closure(
    cx: Ctx,
    func: Raw,
    _this: Raw,
    argc: c_int,
    argv: *mut Raw,
    _flags: c_int,
) -> Raw {
    // SAFETY: the opaque of closures; the closure object is alive for the
    // call (the caller holds it), and the code only reads it.
    unsafe {
        let p = qjs::JS_GetAnyOpaque(func, &mut 0) as *const Closure;
        let Some(c) = p.as_ref() else {
            return qjs::JS_UNDEFINED;
        };
        // Rust code (a callback's reply converts the app's values): a panic
        // throws instead of unwinding into QuickJS.
        let args = Args::new(argc, argv);
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (c.f)(cx, &c.captures, args)
        })) {
            Ok(Ok(v)) => v.take(),
            Ok(Err(Throw)) => qjs::JS_EXCEPTION,
            Err(_) => {
                let e = qjs::JS_NewError(cx);
                if let Ok(m) = js::string(cx, "a Rust function panicked") {
                    qjs::JS_SetPropertyStr(cx, e, c"message".as_ptr(), m.take());
                }
                qjs::JS_Throw(cx, e)
            }
        }
    }
}

/// Registers the two classes (once per context).
fn register(cx: Ctx) {
    let w = web(cx);
    if w.object_class != 0 {
        return;
    }
    // SAFETY: registering classes on the context's runtime.
    unsafe {
        let rt = qjs::JS_GetRuntime(cx);
        let class = |name: &'static CStr, finalizer, gc_mark, call| {
            let mut id: qjs::JSClassID = 0;
            qjs::JS_NewClassID(rt, &mut id);
            let def = qjs::JSClassDef {
                class_name: name.as_ptr(),
                finalizer: Some(finalizer),
                gc_mark: Some(gc_mark),
                call,
                exotic: ptr::null_mut(),
            };
            qjs::JS_NewClass(rt, id, &def);
            id
        };
        w.object_class = class(c"WebObject", finalize, mark, None);
        w.closure_class = class(
            c"WebFunction",
            finalize_closure,
            mark_closure,
            Some(call_closure),
        );
    }
}

/// A function object running `closure`.
pub(crate) fn new_closure(cx: Ctx, closure: Closure) -> R<V> {
    register(cx);
    let class = web(cx).closure_class;
    // SAFETY: a function prototype for the callable object; it owns the
    // closure.
    unsafe {
        let proto = qjs::JS_GetFunctionProto(cx);
        let obj = V::checked(cx, qjs::JS_NewObjectProtoClass(cx, proto, class))?;
        qjs::JS_FreeValue(cx, proto);
        qjs::JS_SetOpaque(obj.raw(), Box::into_raw(Box::new(closure)) as *mut c_void);
        Ok(obj)
    }
}

/// A new `AbortSignal` (owned): a resource's load gets one, aborted when the
/// load no longer counts.
pub(crate) fn new_abort_signal(cx: Ctx) -> R<Raw> {
    event::new_signal(cx).map(V::take)
}

/// Aborts `signal` with an `AbortError` (nothing when it is aborted).
pub(crate) fn abort_signal(cx: Ctx, signal: Raw) -> R<()> {
    event::abort(cx, signal, UNDEFINED)
}

/// The intrinsic `Promise.prototype.then`.
pub(crate) fn intrinsic_then(cx: Ctx) -> R<V> {
    build(cx)?;
    Ok(web(cx).then.clone_ref())
}

/// The function cached at `index` (made on first use).
pub(crate) fn cached_function(cx: Ctx, index: usize, name: &CStr, f: Native) -> R<V> {
    if let Some(v) = web(cx).cached.get(index).filter(|v| !v.is_undefined()) {
        return Ok(v.clone_ref());
    }
    let func = js::function(cx, name, f, 1)?;
    let w = web(cx);
    if w.cached.len() <= index {
        w.cached.resize_with(index + 1, V::undefined);
    }
    w.cached[index] = func.clone_ref();
    Ok(func)
}

/// The prototype of `class`.
pub(crate) fn proto(cx: Ctx, class: Class) -> R<V> {
    build(cx)?;
    Ok(web(cx).protos[class as usize].clone_ref())
}

/// The constructor of `class`.
pub(crate) fn constructor(cx: Ctx, class: Class) -> R<V> {
    build(cx)?;
    Ok(web(cx).ctors[class as usize].clone_ref())
}

/// A new object of `class` holding `data`: with `new_target`'s prototype
/// when constructed (`undefined`: made internally).
pub(crate) fn instance(cx: Ctx, new_target: Raw, class: Class, data: impl Object) -> R<V> {
    let proto = if js::is_object(new_target) {
        let p = js::get(cx, new_target, "prototype")?;
        if js::is_object(p.raw()) {
            p
        } else {
            proto(cx, class)?
        }
    } else {
        proto(cx, class)?
    };
    instance_of_proto(cx, proto.raw(), data)
}

/// A new object holding `data` with prototype `proto` (the classes of
/// Rust's `#[class]`, `classes.rs`, whose prototypes are made at run time).
pub(crate) fn instance_of_proto(cx: Ctx, proto: Raw, data: impl Object) -> R<V> {
    register(cx);
    let id = web(cx).object_class;
    // SAFETY: an object of the web class owning its slot.
    unsafe {
        let obj = V::checked(cx, qjs::JS_NewObjectProtoClass(cx, proto, id))?;
        let slot: Box<Slot> = Box::new(Slot(RefCell::new(Box::new(data))));
        qjs::JS_SetOpaque(obj.raw(), Box::into_raw(slot) as *mut c_void);
        Ok(obj)
    }
}

fn slot<'a>(cx: Ctx, v: Raw) -> Option<&'a Slot> {
    let id = web(cx).object_class;
    if id == 0 {
        return None;
    }
    // SAFETY: the opaque of the web class (null for other values); the
    // object outlives the borrow (callers hold `v`).
    unsafe { (js::opaque(v, id) as *const Slot).as_ref() }
}

/// The data of `v` as a `T`, borrowed (`TypeError` for other values, and
/// for a re-entrant use).
pub(crate) fn data<'a, T: Object>(cx: Ctx, v: Raw, what: &str) -> R<RefMut<'a, T>> {
    let illegal = |cx| js::type_error(cx, &format!("Illegal invocation: not a {what}"));
    let slot = slot(cx, v).ok_or_else(|| illegal(cx))?;
    let b = slot
        .0
        .try_borrow_mut()
        .map_err(|_| js::type_error(cx, &format!("{what} used re-entrantly")))?;
    RefMut::filter_map(b, |d| (d.as_mut() as &mut dyn Any).downcast_mut::<T>())
        .map_err(|_| illegal(cx))
}

/// `f` of the data of `v` as a `T`, without throwing (`None`: another
/// value, or one in use).
pub(crate) fn peek<T: Object, R>(cx: Ctx, v: Raw, f: impl FnOnce(&T) -> R) -> Option<R> {
    let slot = slot(cx, v)?;
    let data = slot.0.try_borrow().ok()?;
    (data.as_ref() as &dyn Any).downcast_ref::<T>().map(f)
}

/// Whether `v` holds a `T`.
pub(crate) fn is<T: Object>(cx: Ctx, v: Raw) -> bool {
    slot(cx, v).is_some_and(|s| {
        s.0.try_borrow()
            .is_ok_and(|d| (d.as_ref() as &dyn Any).is::<T>())
    })
}

/// The data of `v` through a role (`EventTarget` of subclasses).
pub(crate) fn role<'a, T>(
    cx: Ctx,
    v: Raw,
    what: &str,
    f: impl FnOnce(&mut dyn Object) -> Option<&mut T>,
) -> R<RefMut<'a, T>> {
    let illegal = |cx| js::type_error(cx, &format!("Illegal invocation: not a {what}"));
    let slot = slot(cx, v).ok_or_else(|| illegal(cx))?;
    let b = slot
        .0
        .try_borrow_mut()
        .map_err(|_| js::type_error(cx, &format!("{what} used re-entrantly")))?;
    RefMut::filter_map(b, |d| f(d.as_mut())).map_err(|_| illegal(cx))
}

native!(
    /// The constructor of a class made only internally.
    fn illegal_constructor(cx, this, args) {
        Err(js::type_error(cx, "Illegal constructor"))
    }
);
use js::native;

/// Makes the classes and functions (once per context).
fn build(cx: Ctx) -> R<()> {
    register(cx);
    if web(cx).built {
        return Ok(());
    }
    web(cx).built = true;
    let g = js::global(cx);
    let promise = js::get(cx, g.raw(), "Promise")?;
    let promise_proto = js::get(cx, promise.raw(), "prototype")?;
    let then = js::get(cx, promise_proto.raw(), "then")?;
    let mut protos: Vec<Option<V>> = (0..CLASS_COUNT).map(|_| None).collect();
    let mut ctors: Vec<Option<V>> = (0..CLASS_COUNT).map(|_| None).collect();
    for spec in specs() {
        let (proto, ctor) = make_class(cx, spec, &protos, &ctors)?;
        protos[spec.class as usize] = Some(proto);
        ctors[spec.class as usize] = Some(ctor);
    }
    // The iterators inherit `%IteratorPrototype%`'s helpers.
    let array = js::new_array(cx, Vec::new())?;
    let array_iterator = js::invoke(cx, array.raw(), "values", &[])?;
    // SAFETY: live objects; the prototypes are borrowed.
    unsafe {
        let array_iterator_proto = V::own(cx, qjs::JS_GetPrototype(cx, array_iterator.raw()));
        let iterator_proto = V::own(cx, qjs::JS_GetPrototype(cx, array_iterator_proto.raw()));
        if let Some(p) = &protos[Class::Iterator as usize] {
            qjs::JS_SetPrototype(cx, p.raw(), iterator_proto.raw());
        }
    }
    let w = web(cx);
    w.protos = protos.into_iter().map(Option::unwrap_or_default).collect();
    w.ctors = ctors.into_iter().map(Option::unwrap_or_default).collect();
    w.then = then;
    Ok(())
}

fn make_class(cx: Ctx, spec: &Spec, protos: &[Option<V>], ctors: &[Option<V>]) -> R<(V, V)> {
    let parent = spec.parent.map(|p| p as usize);
    let proto = js::new_object(cx)?;
    if let Some(p) = parent.and_then(|p| protos[p].as_ref()) {
        // SAFETY: live objects.
        unsafe { qjs::JS_SetPrototype(cx, proto.raw(), p.raw()) };
    }
    let (f, length) = spec.constructor.unwrap_or((illegal_constructor, 0));
    // SAFETY: a constructor-only C function (`this` is `new.target`).
    let ctor = V::checked(cx, unsafe {
        qjs::JS_NewCFunction2(
            cx,
            Some(f),
            spec.name.as_ptr(),
            length,
            qjs::JSCFunctionEnum_JS_CFUNC_constructor,
            0,
        )
    })?;
    // SAFETY: links `prototype` / `constructor` both ways.
    unsafe { qjs::JS_SetConstructor(cx, ctor.raw(), proto.raw()) };
    if let Some(c) = parent.and_then(|p| ctors[p].as_ref()) {
        // SAFETY: static members are inherited too.
        unsafe { qjs::JS_SetPrototype(cx, ctor.raw(), c.raw()) };
    }
    for (key, f, length) in spec.methods {
        let (name, atom) = match key {
            Key::Name(n) => (*n, None),
            Key::Iterator => (c"[Symbol.iterator]", Some(qjs::JS_ATOM_Symbol_iterator)),
            Key::AsyncIterator => (
                c"[Symbol.asyncIterator]",
                Some(qjs::JS_ATOM_Symbol_asyncIterator),
            ),
        };
        let func = js::function(cx, name, *f, *length)?;
        let flags = (qjs::JS_PROP_WRITABLE | qjs::JS_PROP_CONFIGURABLE) as c_int;
        // SAFETY: the property takes the function.
        unsafe {
            match atom {
                Some(atom) => {
                    qjs::JS_DefinePropertyValue(cx, proto.raw(), atom as _, func.take(), flags);
                }
                None => {
                    qjs::JS_DefinePropertyValueStr(
                        cx,
                        proto.raw(),
                        name.as_ptr(),
                        func.take(),
                        flags,
                    );
                }
            }
        }
    }
    for (name, getter, setter) in spec.accessors {
        let get = js::function(cx, name, *getter, 0)?;
        let set = match setter {
            Some(s) => js::function(cx, name, *s, 1)?,
            None => V::undefined(),
        };
        // SAFETY: the property takes the functions.
        unsafe {
            let atom = qjs::JS_NewAtom(cx, name.as_ptr());
            qjs::JS_DefinePropertyGetSet(
                cx,
                proto.raw(),
                atom,
                get.take(),
                set.take(),
                (qjs::JS_PROP_CONFIGURABLE | qjs::JS_PROP_ENUMERABLE) as c_int,
            );
            qjs::JS_FreeAtom(cx, atom);
        }
    }
    for (name, f, length) in spec.statics {
        let func = js::function(cx, name, *f, *length)?;
        // SAFETY: the property takes the function.
        unsafe {
            qjs::JS_DefinePropertyValueStr(
                cx,
                ctor.raw(),
                name.as_ptr(),
                func.take(),
                (qjs::JS_PROP_WRITABLE | qjs::JS_PROP_CONFIGURABLE) as c_int,
            );
        }
    }
    for (name, value) in spec.constants {
        for target in [ctor.raw(), proto.raw()] {
            // SAFETY: a read-only, enumerable number.
            unsafe {
                qjs::JS_DefinePropertyValueStr(
                    cx,
                    target,
                    name.as_ptr(),
                    qjs::JS_NewFloat64(*value),
                    qjs::JS_PROP_ENUMERABLE as c_int,
                );
            }
        }
    }
    // `Object.prototype.toString` gives `[object Name]`, as in browsers
    // (libraries test kinds this way).
    let tag = js::string(cx, &spec.name.to_string_lossy())?;
    // SAFETY: the property takes the string.
    unsafe {
        qjs::JS_DefinePropertyValue(
            cx,
            proto.raw(),
            qjs::JS_ATOM_Symbol_toStringTag as _,
            tag.take(),
            qjs::JS_PROP_CONFIGURABLE as c_int,
        );
    }
    Ok((proto, ctor))
}

/// The value of global `name` (a class or a function).
fn global_value(cx: Ctx, name: &CStr) -> R<V> {
    build(cx)?;
    if name == INTL {
        return intl::namespace(cx);
    }
    if let Some(spec) = specs().find(|s| s.global && s.name == name) {
        return constructor(cx, spec.class);
    }
    let f = functions()
        .find(|f| f.name == name)
        .ok_or_else(|| js::type_error(cx, "unknown global"))?;
    js::function(cx, f.name, f.native, f.length)
}

/// `Intl`: a namespace, not a class.
const INTL: &CStr = c"Intl";

/// The globals TypeScript's ECMAScript library declares (`globals.d.ts`
/// does not).
#[cfg(test)]
pub(crate) const ECMASCRIPT_GLOBALS: &[&str] = &["Intl"];

fn global_names() -> impl Iterator<Item = &'static CStr> {
    specs()
        .filter(|s| s.global)
        .map(|s| s.name)
        .chain(functions().map(|f| f.name))
        .chain([INTL])
}

/// Replaces the lazy accessors still in place with the values.
fn materialize(cx: Ctx) -> R<()> {
    let g = js::global(cx);
    for name in global_names() {
        // SAFETY: reading an own property's descriptor of the global.
        let accessor = unsafe {
            let atom = qjs::JS_NewAtom(cx, name.as_ptr());
            let mut desc = std::mem::zeroed::<qjs::JSPropertyDescriptor>();
            let r = qjs::JS_GetOwnProperty(cx, &mut desc, g.raw(), atom);
            qjs::JS_FreeAtom(cx, atom);
            if r < 0 {
                return Err(Throw);
            }
            let accessor = r == 1 && (desc.flags & qjs::JS_PROP_GETSET as c_int) != 0;
            if r == 1 {
                qjs::JS_FreeValue(cx, desc.value);
                qjs::JS_FreeValue(cx, desc.getter);
                qjs::JS_FreeValue(cx, desc.setter);
            }
            accessor
        };
        if accessor {
            let value = global_value(cx, name)?;
            js::define(cx, g.raw(), &name.to_string_lossy(), value, false)?;
        }
    }
    Ok(())
}

/// The lazy accessor of the globals: makes everything, then returns
/// global `magic`.
unsafe extern "C" fn lazy_get(
    cx: Ctx,
    _this: Raw,
    _argc: c_int,
    _argv: *mut Raw,
    magic: c_int,
    _data: *mut Raw,
) -> Raw {
    let Some(name) = global_names().nth(magic as usize) else {
        return UNDEFINED;
    };
    let result = (|| {
        materialize(cx)?;
        let g = js::global(cx);
        js::get(cx, g.raw(), &name.to_string_lossy())
    })();
    match result {
        Ok(v) => v.take(),
        Err(Throw) => qjs::JS_EXCEPTION,
    }
}

/// An app assigning a global before reading it: its value wins.
unsafe extern "C" fn lazy_set(
    cx: Ctx,
    _this: Raw,
    argc: c_int,
    argv: *mut Raw,
    magic: c_int,
    _data: *mut Raw,
) -> Raw {
    let Some(name) = global_names().nth(magic as usize) else {
        return UNDEFINED;
    };
    // SAFETY: QuickJS passes `argc` live arguments.
    let value = unsafe { Args::new(argc, argv) }.get(0);
    let g = js::global(cx);
    match js::define(
        cx,
        g.raw(),
        &name.to_string_lossy(),
        V::dup(cx, value),
        false,
    ) {
        Ok(()) => UNDEFINED,
        Err(Throw) => qjs::JS_EXCEPTION,
    }
}

/// Delivers an event of request `id` (from the network stack).
pub(crate) fn fetch_event(
    cx: Ctx,
    id: crate::net::RequestId,
    event: crate::net::FetchEvent,
) -> R<()> {
    // Events of requests made before the classes were (none) need nothing.
    if !web(cx).built {
        return Ok(());
    }
    fetch::event(cx, id, event)
}

/// Cancels the requests whose response bodies were collected unread.
pub(crate) fn forget_dropped_fetches(cx: Ctx) {
    fetch::forget_dropped(cx);
}

/// Defines the globals as accessors that make the classes on first use
/// (an app that uses none pays nothing).
pub(crate) fn install(cx: Ctx) -> rquickjs::Result<()> {
    intl::install(cx).map_err(|Throw| rquickjs::Error::Exception)?;
    let g = js::global(cx);
    for (i, name) in global_names().enumerate() {
        // SAFETY: new functions the property takes.
        unsafe {
            let get =
                qjs::JS_NewCFunctionData(cx, Some(lazy_get), 0, i as c_int, 0, ptr::null_mut());
            let set =
                qjs::JS_NewCFunctionData(cx, Some(lazy_set), 1, i as c_int, 0, ptr::null_mut());
            let atom = qjs::JS_NewAtom(cx, name.as_ptr());
            let r = qjs::JS_DefinePropertyGetSet(
                cx,
                g.raw(),
                atom,
                get,
                set,
                qjs::JS_PROP_CONFIGURABLE as c_int,
            );
            qjs::JS_FreeAtom(cx, atom);
            if r < 0 {
                return Err(rquickjs::Error::Exception);
            }
        }
    }
    Ok(())
}
