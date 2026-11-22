//! `TransformStream` and its controller.

use std::cell::RefMut;

use super::{
    Algo, QueuingStrategy, method,
    readable::{self, State},
    writable::{self, WState},
};
use crate::web::{
    Class, Key, Object, Spec, data, instance,
    js::{self, Ctx, Deferred, R, Raw, V, native, trace},
};

pub(crate) struct Stream {
    pub(crate) readable: V,
    pub(crate) writable: V,
    backpressure: Option<bool>,
    backpressure_change: Option<Deferred>,
    controller: V,
}

trace!(Stream {
    readable,
    writable,
    backpressure_change,
    controller
});

impl Object for Stream {}

pub(crate) struct Controller {
    stream: V,
    transform: Algo,
    flush: Algo,
    cancel: Algo,
    finish: Option<Deferred>,
}

trace!(Controller {
    stream,
    transform,
    flush,
    cancel,
    finish
});

impl Object for Controller {}

fn stream<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, Stream>> {
    data::<Stream>(cx, v, "TransformStream")
}

fn controller<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, Controller>> {
    data::<Controller>(cx, v, "TransformStreamDefaultController")
}

fn parts(cx: Ctx, s: Raw) -> R<(V, V, V)> {
    let st = stream(cx, s)?;
    Ok((
        st.readable.clone_ref(),
        st.writable.clone_ref(),
        st.controller.clone_ref(),
    ))
}

/// The controller of the readable side.
fn readable_controller(cx: Ctx, s: Raw) -> R<V> {
    let r = stream(cx, s)?.readable.clone_ref();
    readable::controller_of(cx, r.raw())
}

fn readable_controller_of(cx: Ctx, r: Raw) -> R<V> {
    readable::controller_of(cx, r)
}

/// SetBackpressure.
fn set_backpressure(cx: Ctx, s: Raw, backpressure: bool) -> R<()> {
    let old = {
        let mut st = stream(cx, s)?;
        let old = st.backpressure_change.replace(Deferred::new(cx)?);
        st.backpressure = Some(backpressure);
        old
    };
    if let Some(d) = old {
        d.resolve(cx, js::UNDEFINED);
    }
    Ok(())
}

fn unblock_write(cx: Ctx, s: Raw) -> R<()> {
    if stream(cx, s)?.backpressure == Some(true) {
        set_backpressure(cx, s, false)?;
    }
    Ok(())
}

fn clear_algorithms(cx: Ctx, c: Raw) -> R<()> {
    let old = {
        let mut ct = controller(cx, c)?;
        (
            std::mem::take(&mut ct.transform),
            std::mem::take(&mut ct.flush),
            std::mem::take(&mut ct.cancel),
        )
    };
    drop(old);
    Ok(())
}

/// TransformStreamErrorWritableAndUnblockWrite.
fn error_writable_and_unblock(cx: Ctx, s: Raw, e: Raw) -> R<()> {
    let (_, w, c) = parts(cx, s)?;
    clear_algorithms(cx, c.raw())?;
    let wc = writable::controller_of(cx, w.raw())?;
    writable::error_if_needed(cx, wc.raw(), e)?;
    unblock_write(cx, s)
}

/// TransformStreamError.
fn error_stream(cx: Ctx, s: Raw, e: Raw) -> R<()> {
    let rc = readable_controller(cx, s)?;
    readable::dc_error(cx, rc.raw(), e)?;
    error_writable_and_unblock(cx, s, e)
}

/// TransformStreamDefaultControllerEnqueue.
pub(crate) fn enqueue(cx: Ctx, c: Raw, chunk: Raw) -> R<()> {
    let s = controller(cx, c)?.stream.clone_ref();
    let rc = readable_controller(cx, s.raw())?;
    if !readable::dc_can_close_or_enqueue(cx, rc.raw())? {
        return Err(js::type_error(
            cx,
            "the readable side cannot be enqueued to",
        ));
    }
    if readable::dc_enqueue(cx, rc.raw(), chunk).is_err() {
        let e = js::take_exception(cx);
        error_writable_and_unblock(cx, s.raw(), e.raw())?;
        let r = stream(cx, s.raw())?.readable.clone_ref();
        let stored = readable::stored_error(cx, r.raw())?;
        return Err(js::throw(cx, stored));
    }
    let bp = readable::dc_has_backpressure(cx, rc.raw())?;
    if Some(bp) != stream(cx, s.raw())?.backpressure {
        set_backpressure(cx, s.raw(), true)?;
    }
    Ok(())
}

/// TransformStreamDefaultControllerTerminate.
fn terminate(cx: Ctx, c: Raw) -> R<()> {
    let s = controller(cx, c)?.stream.clone_ref();
    let rc = readable_controller(cx, s.raw())?;
    readable::dc_close(cx, rc.raw())?;
    let e = js::type_error_value(cx, "the TransformStream was terminated");
    error_writable_and_unblock(cx, s.raw(), e.raw())
}

/// TransformStreamDefaultControllerPerformTransform.
fn perform_transform(cx: Ctx, c: Raw, chunk: Raw) -> R<V> {
    let transform = controller(cx, c)?.transform.clone_ref();
    let p = transform.promise(cx, &[chunk, c])?;
    let s = controller(cx, c)?.stream.clone_ref();
    let on_error = js::closure(cx, vec![s], |cx, cap, args| {
        error_stream(cx, cap[0].raw(), args.get(0))?;
        Err(js::throw(cx, V::dup(cx, args.get(0))))
    })?;
    js::then(cx, p.raw(), js::UNDEFINED, on_error.raw())
}

fn sink_write(cx: Ctx, s: Raw, chunk: Raw) -> R<V> {
    let (backpressure, change, c) = {
        let st = stream(cx, s)?;
        (
            st.backpressure,
            st.backpressure_change
                .as_ref()
                .map(|d| d.promise.clone_ref()),
            st.controller.clone_ref(),
        )
    };
    if backpressure == Some(true)
        && let Some(change) = change
    {
        let then = js::closure(
            cx,
            vec![V::dup(cx, s), c, V::dup(cx, chunk)],
            |cx, cap, _| {
                let w = stream(cx, cap[0].raw())?.writable.clone_ref();
                if writable::state_of(cx, w.raw())? == WState::Erroring {
                    let e = writable::stored_error(cx, w.raw())?;
                    return Err(js::throw(cx, e));
                }
                perform_transform(cx, cap[1].raw(), cap[2].raw())
            },
        )?;
        return js::then(cx, change.raw(), then.raw(), js::UNDEFINED);
    }
    perform_transform(cx, c.raw(), chunk)
}

/// The finish promise of an algorithm that settles the other side.
fn finish_with(
    cx: Ctx,
    c: Raw,
    run: impl FnOnce(&Controller) -> Algo,
    args: &[Raw],
    on_ok: impl Fn(Ctx, &[V]) -> R<()> + 'static,
    on_err: impl Fn(Ctx, &[V], Raw) -> R<()> + 'static,
    captures: Vec<V>,
) -> R<V> {
    if let Some(d) = &controller(cx, c)?.finish {
        return Ok(d.promise.clone_ref());
    }
    let d = Deferred::new(cx)?;
    let result = d.promise.clone_ref();
    let algo = {
        let mut ct = controller(cx, c)?;
        let a = run(&ct);
        ct.finish = Some(Deferred {
            promise: d.promise.clone_ref(),
            resolve: d.resolve.clone_ref(),
            reject: d.reject.clone_ref(),
        });
        a
    };
    let p = algo.promise(cx, args)?;
    clear_algorithms(cx, c)?;
    let mut caps = captures;
    caps.push(d.resolve.clone_ref());
    caps.push(d.reject.clone_ref());
    js::upon(
        cx,
        p.raw(),
        caps,
        move |cx, cap, _| {
            let n = cap.len();
            match on_ok(cx, &cap[..n - 2]) {
                Ok(()) => js::call(cx, cap[n - 2].raw(), js::UNDEFINED, &[js::UNDEFINED]).map(drop),
                Err(_) => {
                    let e = js::take_exception(cx);
                    js::call(cx, cap[n - 1].raw(), js::UNDEFINED, &[e.raw()]).map(drop)
                }
            }
        },
        move |cx, cap, e| {
            let n = cap.len();
            on_err(cx, &cap[..n - 2], e)?;
            js::call(cx, cap[n - 1].raw(), js::UNDEFINED, &[e]).map(drop)
        },
    )?;
    Ok(result)
}

fn sink_abort(cx: Ctx, s: Raw, reason: Raw) -> R<V> {
    let (r, _, c) = parts(cx, s)?;
    finish_with(
        cx,
        c.raw(),
        |ct| ct.cancel.clone_ref(),
        &[reason],
        |cx, cap| {
            let r = cap[0].raw();
            if readable::state_of(cx, r)? == State::Errored {
                let e = readable::stored_error(cx, r)?;
                return Err(js::throw(cx, e));
            }
            let rc = readable_controller_of(cx, r)?;
            readable::dc_error(cx, rc.raw(), cap[1].raw())
        },
        |cx, cap, e| {
            let rc = readable_controller_of(cx, cap[0].raw())?;
            readable::dc_error(cx, rc.raw(), e)
        },
        vec![r, V::dup(cx, reason)],
    )
}

fn sink_close(cx: Ctx, s: Raw) -> R<V> {
    let (r, _, c) = parts(cx, s)?;
    finish_with(
        cx,
        c.raw(),
        |ct| ct.flush.clone_ref(),
        &[c.raw()],
        |cx, cap| {
            let r = cap[0].raw();
            if readable::state_of(cx, r)? == State::Errored {
                let e = readable::stored_error(cx, r)?;
                return Err(js::throw(cx, e));
            }
            let rc = readable_controller_of(cx, r)?;
            readable::dc_close(cx, rc.raw())
        },
        |cx, cap, e| {
            let rc = readable_controller_of(cx, cap[0].raw())?;
            readable::dc_error(cx, rc.raw(), e)
        },
        vec![r],
    )
}

fn source_cancel(cx: Ctx, s: Raw, reason: Raw) -> R<V> {
    let (_, w, c) = parts(cx, s)?;
    finish_with(
        cx,
        c.raw(),
        |ct| ct.cancel.clone_ref(),
        &[reason],
        |cx, cap| {
            let w = cap[0].raw();
            if writable::state_of(cx, w)? == WState::Errored {
                let e = writable::stored_error(cx, w)?;
                return Err(js::throw(cx, e));
            }
            let wc = writable::controller_of(cx, w)?;
            writable::error_if_needed(cx, wc.raw(), cap[2].raw())?;
            unblock_write(cx, cap[1].raw())
        },
        |cx, cap, e| {
            let wc = writable::controller_of(cx, cap[0].raw())?;
            writable::error_if_needed(cx, wc.raw(), e)?;
            unblock_write(cx, cap[1].raw())
        },
        vec![w, V::dup(cx, s), V::dup(cx, reason)],
    )
}

fn source_pull(cx: Ctx, s: Raw) -> R<V> {
    set_backpressure(cx, s, false)?;
    let change = stream(cx, s)?
        .backpressure_change
        .as_ref()
        .map(|d| d.promise.clone_ref());
    match change {
        Some(p) => Ok(p),
        None => js::resolved(cx, js::UNDEFINED),
    }
}

/// The algorithms of a transformer.
pub(crate) struct Transformer {
    pub(crate) transform: Algo,
    pub(crate) flush: Algo,
    pub(crate) cancel: Algo,
}

/// The queuing of the two sides: high water marks and size algorithms.
pub(crate) struct Sides {
    pub(crate) writable_hwm: f64,
    pub(crate) writable_size: V,
    pub(crate) readable_hwm: f64,
    pub(crate) readable_size: V,
}

impl Sides {
    /// The defaults (`new TransformStream()` without strategies).
    pub(crate) fn default_sides() -> Sides {
        Sides {
            writable_hwm: 1.0,
            writable_size: V::undefined(),
            readable_hwm: 0.0,
            readable_size: V::undefined(),
        }
    }
}

/// InitializeTransformStream and the controller's setup: a transform
/// stream of `transformer`, started when the returned promise resolves.
pub(crate) fn new_transform(
    cx: Ctx,
    new_target: Raw,
    class: Class,
    transformer: Transformer,
    sides: Sides,
) -> R<(V, V, Deferred)> {
    let Transformer {
        transform,
        flush,
        cancel,
    } = transformer;
    let Sides {
        writable_hwm,
        writable_size,
        readable_hwm,
        readable_size,
    } = sides;
    let s = instance(
        cx,
        new_target,
        class,
        Stream {
            readable: V::undefined(),
            writable: V::undefined(),
            backpressure: None,
            backpressure_change: None,
            controller: V::undefined(),
        },
    )?;
    let start = Deferred::new(cx)?;
    let start_promise = start.promise.clone_ref();
    let start_algo = js::closure(cx, vec![start_promise], |_, c, _| Ok(c[0].clone_ref()))?;
    let write = js::closure(cx, vec![s.clone_ref()], |cx, c, args| {
        sink_write(cx, c[0].raw(), args.get(0))
    })?;
    let abort = js::closure(cx, vec![s.clone_ref()], |cx, c, args| {
        sink_abort(cx, c[0].raw(), args.get(0))
    })?;
    let close = js::closure(cx, vec![s.clone_ref()], |cx, c, _| {
        sink_close(cx, c[0].raw())
    })?;
    let sink = writable::Sink {
        start: Algo::native(start_algo.clone_ref()),
        write: Algo::native(write),
        close: Algo::native(close),
        abort: Algo::native(abort),
    };
    let (w, _) = writable::new_writable_stream(cx, sink, writable_hwm, writable_size)?;
    let pull = js::closure(cx, vec![s.clone_ref()], |cx, c, _| {
        source_pull(cx, c[0].raw())
    })?;
    let cancel_source = js::closure(cx, vec![s.clone_ref()], |cx, c, args| {
        source_cancel(cx, c[0].raw(), args.get(0))
    })?;
    let (r, _) = readable::new_default_stream(
        cx,
        Algo::native(start_algo),
        Algo::native(pull),
        Algo::native(cancel_source),
        readable_hwm,
        readable_size,
    )?;
    {
        let mut st = stream(cx, s.raw())?;
        st.readable = r;
        st.writable = w;
    }
    set_backpressure(cx, s.raw(), true)?;
    let c = instance(
        cx,
        js::UNDEFINED,
        Class::TransformStreamDefaultController,
        Controller {
            stream: s.clone_ref(),
            transform,
            flush,
            cancel,
            finish: None,
        },
    )?;
    stream(cx, s.raw())?.controller = c.clone_ref();
    Ok((s, c, start))
}

native!(
    /// The default transform: chunks pass through.
    fn identity_transform(cx, this, args) {
        enqueue(cx, args.get(1), args.get(0))?;
        Ok(V::undefined())
    }
);

native!(
    fn stream_constructor(cx, this, args) {
        let transformer = args.get(0);
        if !js::is_nullish(transformer) && !js::is_object(transformer) {
            return Err(js::type_error(cx, "the transformer must be an object"));
        }
        let writable_strategy = QueuingStrategy::read(cx, args.get(1))?;
        let readable_strategy = QueuingStrategy::read(cx, args.get(2))?;
        let t = V::dup(cx, transformer);
        let cancel = method(cx, transformer, "cancel")?;
        let flush = method(cx, transformer, "flush")?;
        if js::is_object(transformer) {
            for key in ["readableType", "writableType"] {
                let v = js::get(cx, transformer, key)?;
                if !v.is_undefined() {
                    return Err(js::range_error(cx, &format!("{key} is not supported")));
                }
            }
        }
        let start = method(cx, transformer, "start")?;
        let transform = method(cx, transformer, "transform")?;
        let readable_hwm = readable_strategy.high_water_mark(cx, 0.0)?;
        let writable_hwm = writable_strategy.high_water_mark(cx, 1.0)?;
        let transform = if transform.is_undefined() {
            Algo::native(js::function(cx, c"transform", identity_transform, 2)?)
        } else {
            Algo::method(transform, &t)
        };
        let transformer = Transformer {
            transform,
            flush: Algo::method(flush, &t),
            cancel: Algo::method(cancel, &t),
        };
        let sides = Sides {
            writable_hwm,
            writable_size: writable_strategy.size,
            readable_hwm,
            readable_size: readable_strategy.size,
        };
        let (s, c, start_promise) = new_transform(cx, this, Class::TransformStream, transformer, sides)?;
        let started = Algo::method(start, &t).call(cx, &[c.raw()])?;
        start_promise.resolve(cx, started.raw());
        Ok(s)
    }
);

native!(
    fn stream_readable(cx, this, args) {
        Ok(stream(cx, this)?.readable.clone_ref())
    }
);

native!(
    fn stream_writable(cx, this, args) {
        Ok(stream(cx, this)?.writable.clone_ref())
    }
);

native!(
    fn controller_desired_size(cx, this, args) {
        let s = controller(cx, this)?.stream.clone_ref();
        let rc = readable_controller(cx, s.raw())?;
        Ok(match readable::dc_desired_size(cx, rc.raw())? {
            Some(n) => V::num(n),
            None => V::null(),
        })
    }
);

native!(
    fn controller_enqueue(cx, this, args) {
        enqueue(cx, this, args.get(0))?;
        Ok(V::undefined())
    }
);

native!(
    fn controller_error(cx, this, args) {
        let s = controller(cx, this)?.stream.clone_ref();
        error_stream(cx, s.raw(), args.get(0))?;
        Ok(V::undefined())
    }
);

native!(
    fn controller_terminate(cx, this, args) {
        terminate(cx, this)?;
        Ok(V::undefined())
    }
);

pub(crate) const SPECS: &[Spec] = &[
    Spec {
        class: Class::TransformStream,
        name: c"TransformStream",
        parent: None,
        constructor: Some((stream_constructor, 0)),
        methods: &[],
        accessors: &[
            (c"readable", stream_readable, None),
            (c"writable", stream_writable, None),
        ],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "<I = any, O = any>",
            members: r#"constructor(transformer?: Transformer<I, O>, writableStrategy?: QueuingStrategy<I>, readableStrategy?: QueuingStrategy<O>);
readonly readable: ReadableStream<O>;
readonly writable: WritableStream<I>;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::TransformStreamDefaultController,
        name: c"TransformStreamDefaultController",
        parent: None,
        constructor: None,
        methods: &[
            (Key::Name(c"enqueue"), controller_enqueue, 0),
            (Key::Name(c"error"), controller_error, 0),
            (Key::Name(c"terminate"), controller_terminate, 0),
        ],
        accessors: &[(c"desiredSize", controller_desired_size, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "<O = any>",
            members: r#"readonly desiredSize: number | null;
enqueue(chunk?: O): void;
error(reason?: any): void;
terminate(): void;"#,
        }
        .declared(),
    },
];

/// The TypeScript types of this file's classes (`globals.d.ts`).
pub(crate) const TYPES: &str = r#"interface Transformer<I = any, O = any> {
  start?(controller: TransformStreamDefaultController<O>): any;
  transform?(chunk: I, controller: TransformStreamDefaultController<O>): void | PromiseLike<void>;
  flush?(controller: TransformStreamDefaultController<O>): void | PromiseLike<void>;
  cancel?(reason?: any): void | PromiseLike<void>;
}
"#;
