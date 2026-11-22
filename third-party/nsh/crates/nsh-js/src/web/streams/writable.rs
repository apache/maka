//! `WritableStream`, its writer and controller.

use std::{cell::RefMut, collections::VecDeque};

use super::{Algo, QueuingStrategy, SizedQueue, chunk_size, method};
use crate::web::{
    Class, Key, Object, Spec, data, instance, is,
    js::{self, Ctx, Deferred, R, Raw, V, native, trace},
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum WState {
    Writable,
    Closed,
    Erroring,
    Errored,
}

struct PendingAbort {
    promise: Deferred,
    reason: V,
    was_already_erroring: bool,
}

trace!(PendingAbort { promise, reason });

pub(crate) struct Stream {
    state: WState,
    stored_error: V,
    writer: V,
    controller: V,
    in_flight_write: Option<Deferred>,
    close_request: Option<Deferred>,
    in_flight_close: Option<Deferred>,
    pending_abort: Option<PendingAbort>,
    write_requests: VecDeque<Deferred>,
    backpressure: bool,
}

trace!(Stream {
    stored_error,
    writer,
    controller,
    in_flight_write,
    close_request,
    in_flight_close,
    pending_abort,
    write_requests
});

impl Object for Stream {}

pub(crate) struct Writer {
    stream: V,
    ready: Deferred,
    closed: Deferred,
}

trace!(Writer {
    stream,
    ready,
    closed
});

impl Object for Writer {}

/// The marker of a queued close.
struct CloseSentinel;

trace!(CloseSentinel {});

impl Object for CloseSentinel {}

pub(crate) struct Controller {
    stream: V,
    queue: SizedQueue,
    signal_controller: V,
    started: bool,
    hwm: f64,
    size: V,
    write: Algo,
    close: Algo,
    abort: Algo,
}

trace!(Controller {
    stream,
    queue,
    signal_controller,
    size,
    write,
    close,
    abort
});

impl Object for Controller {}

fn stream<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, Stream>> {
    data::<Stream>(cx, v, "WritableStream")
}

fn writer<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, Writer>> {
    data::<Writer>(cx, v, "WritableStreamDefaultWriter")
}

fn controller<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, Controller>> {
    data::<Controller>(cx, v, "WritableStreamDefaultController")
}

pub(crate) fn is_stream(cx: Ctx, v: Raw) -> bool {
    is::<Stream>(cx, v)
}

pub(crate) fn is_locked(cx: Ctx, s: Raw) -> R<bool> {
    Ok(!stream(cx, s)?.writer.is_undefined())
}

pub(crate) fn state_of(cx: Ctx, s: Raw) -> R<WState> {
    Ok(stream(cx, s)?.state)
}

pub(crate) fn stored_error(cx: Ctx, s: Raw) -> R<V> {
    Ok(stream(cx, s)?.stored_error.clone_ref())
}

pub(crate) fn controller_of(cx: Ctx, s: Raw) -> R<V> {
    Ok(stream(cx, s)?.controller.clone_ref())
}

/// WritableStreamCloseQueuedOrInFlight.
pub(crate) fn close_queued_or_in_flight(cx: Ctx, s: Raw) -> R<bool> {
    let st = stream(cx, s)?;
    Ok(st.close_request.is_some() || st.in_flight_close.is_some())
}

fn has_operation_in_flight(cx: Ctx, s: Raw) -> R<bool> {
    let st = stream(cx, s)?;
    Ok(st.in_flight_write.is_some() || st.in_flight_close.is_some())
}

fn resolved_deferred(cx: Ctx) -> R<Deferred> {
    let d = Deferred::new(cx)?;
    d.resolve(cx, js::UNDEFINED);
    Ok(d)
}

fn rejected_deferred(cx: Ctx, e: Raw) -> R<Deferred> {
    let d = Deferred::new(cx)?;
    d.reject(cx, e);
    js::mark_handled(cx, d.promise.raw());
    Ok(d)
}

fn is_pending(cx: Ctx, d: &Deferred) -> bool {
    // SAFETY: a live promise.
    unsafe {
        rquickjs::qjs::JS_PromiseState(cx, d.promise.raw())
            == rquickjs::qjs::JSPromiseStateEnum_JS_PROMISE_PENDING
    }
}

fn new_stream(cx: Ctx, new_target: Raw) -> R<V> {
    instance(
        cx,
        new_target,
        Class::WritableStream,
        Stream {
            state: WState::Writable,
            stored_error: V::undefined(),
            writer: V::undefined(),
            controller: V::undefined(),
            in_flight_write: None,
            close_request: None,
            in_flight_close: None,
            pending_abort: None,
            write_requests: VecDeque::new(),
            backpressure: false,
        },
    )
}

// --- Stream operations ----------------------------------------------------

/// WritableStreamAbort.
pub(crate) fn abort_stream(cx: Ctx, s: Raw, reason: Raw) -> R<V> {
    let (state, signal_controller) = {
        let st = stream(cx, s)?;
        let c = st.controller.clone_ref();
        drop(st);
        (
            state_of(cx, s)?,
            controller(cx, c.raw())?.signal_controller.clone_ref(),
        )
    };
    if matches!(state, WState::Closed | WState::Errored) {
        return js::resolved(cx, js::UNDEFINED);
    }
    // Signal the sink's abort first (it may change the state).
    let signal = js::get(cx, signal_controller.raw(), "signal")?;
    crate::web::event::abort(cx, signal.raw(), reason)?;
    let state = state_of(cx, s)?;
    if matches!(state, WState::Closed | WState::Errored) {
        return js::resolved(cx, js::UNDEFINED);
    }
    if let Some(p) = &stream(cx, s)?.pending_abort {
        return Ok(p.promise.promise.clone_ref());
    }
    let was_already_erroring = state == WState::Erroring;
    let reason = if was_already_erroring {
        V::undefined()
    } else {
        V::dup(cx, reason)
    };
    let promise = Deferred::new(cx)?;
    let result = promise.promise.clone_ref();
    stream(cx, s)?.pending_abort = Some(PendingAbort {
        promise,
        reason: reason.clone_ref(),
        was_already_erroring,
    });
    if !was_already_erroring {
        start_erroring(cx, s, reason.raw())?;
    }
    Ok(result)
}

/// WritableStreamClose.
fn close_stream(cx: Ctx, s: Raw) -> R<V> {
    let state = state_of(cx, s)?;
    if matches!(state, WState::Closed | WState::Errored) {
        let e = js::type_error_value(cx, "the stream is closed or errored");
        return js::rejected(cx, e.raw());
    }
    let promise = Deferred::new(cx)?;
    let result = promise.promise.clone_ref();
    let (w, backpressure, c) = {
        let mut st = stream(cx, s)?;
        st.close_request = Some(promise);
        (
            st.writer.clone_ref(),
            st.backpressure,
            st.controller.clone_ref(),
        )
    };
    if !w.is_undefined() && backpressure && state == WState::Writable {
        let resolve = writer(cx, w.raw())?.ready.resolve.clone_ref();
        js::call(cx, resolve.raw(), js::UNDEFINED, &[js::UNDEFINED])?;
    }
    controller_close(cx, c.raw())?;
    Ok(result)
}

/// WritableStreamDealWithRejection.
fn deal_with_rejection(cx: Ctx, s: Raw, e: Raw) -> R<()> {
    if state_of(cx, s)? == WState::Writable {
        return start_erroring(cx, s, e);
    }
    finish_erroring(cx, s)
}

/// WritableStreamStartErroring.
fn start_erroring(cx: Ctx, s: Raw, reason: Raw) -> R<()> {
    let (c, w) = {
        let mut st = stream(cx, s)?;
        st.state = WState::Erroring;
        st.stored_error = V::dup(cx, reason);
        (st.controller.clone_ref(), st.writer.clone_ref())
    };
    if !w.is_undefined() {
        ensure_ready_rejected(cx, w.raw(), reason)?;
    }
    if !has_operation_in_flight(cx, s)? && controller(cx, c.raw())?.started {
        finish_erroring(cx, s)?;
    }
    Ok(())
}

/// WritableStreamFinishErroring.
fn finish_erroring(cx: Ctx, s: Raw) -> R<()> {
    let (c, err, requests, abort) = {
        let mut st = stream(cx, s)?;
        st.state = WState::Errored;
        (
            st.controller.clone_ref(),
            st.stored_error.clone_ref(),
            std::mem::take(&mut st.write_requests),
            st.pending_abort.take(),
        )
    };
    // The controller's error steps.
    let old = controller(cx, c.raw())?.queue.reset();
    drop(old);
    for r in requests {
        r.reject(cx, err.raw());
    }
    let Some(abort) = abort else {
        return reject_close_and_closed_if_needed(cx, s);
    };
    if abort.was_already_erroring {
        abort.promise.reject(cx, err.raw());
        return reject_close_and_closed_if_needed(cx, s);
    }
    let abort_algo = controller(cx, c.raw())?.abort.clone_ref();
    let p = abort_algo.promise(cx, &[abort.reason.raw()])?;
    clear_algorithms(cx, c.raw())?;
    js::upon(
        cx,
        p.raw(),
        vec![
            V::dup(cx, s),
            abort.promise.resolve.clone_ref(),
            abort.promise.reject.clone_ref(),
        ],
        |cx, cap, _| {
            js::call(cx, cap[1].raw(), js::UNDEFINED, &[js::UNDEFINED])?;
            reject_close_and_closed_if_needed(cx, cap[0].raw())
        },
        |cx, cap, e| {
            js::call(cx, cap[2].raw(), js::UNDEFINED, &[e])?;
            reject_close_and_closed_if_needed(cx, cap[0].raw())
        },
    )
}

fn finish_in_flight_write(cx: Ctx, s: Raw) -> R<()> {
    let d = stream(cx, s)?.in_flight_write.take();
    if let Some(d) = d {
        d.resolve(cx, js::UNDEFINED);
    }
    Ok(())
}

fn finish_in_flight_write_with_error(cx: Ctx, s: Raw, e: Raw) -> R<()> {
    let d = stream(cx, s)?.in_flight_write.take();
    if let Some(d) = d {
        d.reject(cx, e);
    }
    deal_with_rejection(cx, s, e)
}

fn finish_in_flight_close(cx: Ctx, s: Raw) -> R<()> {
    let (close, abort, w) = {
        let mut st = stream(cx, s)?;
        let close = st.in_flight_close.take();
        let abort = if st.state == WState::Erroring {
            st.stored_error = V::undefined();
            st.pending_abort.take()
        } else {
            None
        };
        st.state = WState::Closed;
        (close, abort, st.writer.clone_ref())
    };
    if let Some(d) = close {
        d.resolve(cx, js::UNDEFINED);
    }
    if let Some(a) = abort {
        a.promise.resolve(cx, js::UNDEFINED);
    }
    if !w.is_undefined() {
        let resolve = writer(cx, w.raw())?.closed.resolve.clone_ref();
        js::call(cx, resolve.raw(), js::UNDEFINED, &[js::UNDEFINED])?;
    }
    Ok(())
}

fn finish_in_flight_close_with_error(cx: Ctx, s: Raw, e: Raw) -> R<()> {
    let (close, abort) = {
        let mut st = stream(cx, s)?;
        (st.in_flight_close.take(), st.pending_abort.take())
    };
    if let Some(d) = close {
        d.reject(cx, e);
    }
    if let Some(a) = abort {
        a.promise.reject(cx, e);
    }
    deal_with_rejection(cx, s, e)
}

/// WritableStreamRejectCloseAndClosedPromiseIfNeeded.
fn reject_close_and_closed_if_needed(cx: Ctx, s: Raw) -> R<()> {
    let (err, close, w) = {
        let mut st = stream(cx, s)?;
        (
            st.stored_error.clone_ref(),
            st.close_request.take(),
            st.writer.clone_ref(),
        )
    };
    if let Some(d) = close {
        d.reject(cx, err.raw());
    }
    if !w.is_undefined() {
        let closed = {
            let wr = writer(cx, w.raw())?;
            (wr.closed.reject.clone_ref(), wr.closed.promise.clone_ref())
        };
        js::call(cx, closed.0.raw(), js::UNDEFINED, &[err.raw()])?;
        js::mark_handled(cx, closed.1.raw());
    }
    Ok(())
}

/// WritableStreamUpdateBackpressure.
fn update_backpressure(cx: Ctx, s: Raw, backpressure: bool) -> R<()> {
    let (w, current) = {
        let st = stream(cx, s)?;
        (st.writer.clone_ref(), st.backpressure)
    };
    if !w.is_undefined() && backpressure != current {
        if backpressure {
            let d = Deferred::new(cx)?;
            let old = std::mem::replace(&mut writer(cx, w.raw())?.ready, d);
            drop(old);
        } else {
            let resolve = writer(cx, w.raw())?.ready.resolve.clone_ref();
            js::call(cx, resolve.raw(), js::UNDEFINED, &[js::UNDEFINED])?;
        }
    }
    stream(cx, s)?.backpressure = backpressure;
    Ok(())
}

// --- Writer ---------------------------------------------------------------

fn new_writer(cx: Ctx, new_target: Raw, s: Raw) -> R<V> {
    if !is_stream(cx, s) {
        return Err(js::type_error(cx, "not a WritableStream"));
    }
    if is_locked(cx, s)? {
        return Err(js::type_error(cx, "the WritableStream is locked"));
    }
    let (state, err, backpressure, queued) = {
        let st = stream(cx, s)?;
        (
            st.state,
            st.stored_error.clone_ref(),
            st.backpressure,
            st.close_request.is_some() || st.in_flight_close.is_some(),
        )
    };
    let (ready, closed) = match state {
        WState::Writable => {
            let ready = if !queued && backpressure {
                Deferred::new(cx)?
            } else {
                resolved_deferred(cx)?
            };
            (ready, Deferred::new(cx)?)
        }
        WState::Erroring => (rejected_deferred(cx, err.raw())?, Deferred::new(cx)?),
        WState::Closed => (resolved_deferred(cx)?, resolved_deferred(cx)?),
        WState::Errored => (
            rejected_deferred(cx, err.raw())?,
            rejected_deferred(cx, err.raw())?,
        ),
    };
    let w = instance(
        cx,
        new_target,
        Class::WritableStreamDefaultWriter,
        Writer {
            stream: V::dup(cx, s),
            ready,
            closed,
        },
    )?;
    stream(cx, s)?.writer = w.clone_ref();
    Ok(w)
}

/// AcquireWritableStreamDefaultWriter.
pub(crate) fn acquire_writer(cx: Ctx, s: Raw) -> R<V> {
    new_writer(cx, js::UNDEFINED, s)
}

pub(crate) fn writer_closed(cx: Ctx, w: Raw) -> R<V> {
    Ok(writer(cx, w)?.closed.promise.clone_ref())
}

pub(crate) fn writer_ready(cx: Ctx, w: Raw) -> R<V> {
    Ok(writer(cx, w)?.ready.promise.clone_ref())
}

fn ensure_ready_rejected(cx: Ctx, w: Raw, e: Raw) -> R<()> {
    let pending = is_pending(cx, &writer(cx, w)?.ready);
    if pending {
        let (reject, promise) = {
            let wr = writer(cx, w)?;
            (wr.ready.reject.clone_ref(), wr.ready.promise.clone_ref())
        };
        js::call(cx, reject.raw(), js::UNDEFINED, &[e])?;
        js::mark_handled(cx, promise.raw());
    } else {
        let d = rejected_deferred(cx, e)?;
        let old = std::mem::replace(&mut writer(cx, w)?.ready, d);
        drop(old);
    }
    Ok(())
}

fn ensure_closed_rejected(cx: Ctx, w: Raw, e: Raw) -> R<()> {
    let pending = is_pending(cx, &writer(cx, w)?.closed);
    if pending {
        let (reject, promise) = {
            let wr = writer(cx, w)?;
            (wr.closed.reject.clone_ref(), wr.closed.promise.clone_ref())
        };
        js::call(cx, reject.raw(), js::UNDEFINED, &[e])?;
        js::mark_handled(cx, promise.raw());
    } else {
        let d = rejected_deferred(cx, e)?;
        let old = std::mem::replace(&mut writer(cx, w)?.closed, d);
        drop(old);
    }
    Ok(())
}

/// WritableStreamDefaultWriterRelease.
pub(crate) fn writer_release(cx: Ctx, w: Raw) -> R<()> {
    let s = writer(cx, w)?.stream.clone_ref();
    if s.is_undefined() {
        return Ok(());
    }
    let e = js::type_error_value(cx, "the writer was released");
    ensure_ready_rejected(cx, w, e.raw())?;
    ensure_closed_rejected(cx, w, e.raw())?;
    let old = (
        stream(cx, s.raw())?.writer.take_out(),
        writer(cx, w)?.stream.take_out(),
    );
    drop(old);
    Ok(())
}

/// WritableStreamDefaultWriterGetDesiredSize.
fn writer_desired_size(cx: Ctx, s: Raw) -> R<Option<f64>> {
    Ok(match state_of(cx, s)? {
        WState::Errored | WState::Erroring => None,
        WState::Closed => Some(0.0),
        WState::Writable => {
            let c = controller_of(cx, s)?;
            Some(controller_desired_size(cx, c.raw())?)
        }
    })
}

/// WritableStreamDefaultWriterWrite.
pub(crate) fn writer_write(cx: Ctx, w: Raw, chunk: Raw) -> R<V> {
    let s = writer(cx, w)?.stream.clone_ref();
    if s.is_undefined() {
        let e = js::type_error_value(cx, "the writer was released");
        return js::rejected(cx, e.raw());
    }
    let c = controller_of(cx, s.raw())?;
    let size = controller_chunk_size(cx, c.raw(), chunk)?;
    if !js::same(writer(cx, w)?.stream.raw(), s.raw()) {
        let e = js::type_error_value(cx, "the writer was released");
        return js::rejected(cx, e.raw());
    }
    let state = state_of(cx, s.raw())?;
    if state == WState::Errored {
        let e = stored_error(cx, s.raw())?;
        return js::rejected(cx, e.raw());
    }
    if close_queued_or_in_flight(cx, s.raw())? || state == WState::Closed {
        let e = js::type_error_value(cx, "the stream is closing or closed");
        return js::rejected(cx, e.raw());
    }
    if state == WState::Erroring {
        let e = stored_error(cx, s.raw())?;
        return js::rejected(cx, e.raw());
    }
    let d = Deferred::new(cx)?;
    let promise = d.promise.clone_ref();
    stream(cx, s.raw())?.write_requests.push_back(d);
    controller_write(cx, c.raw(), chunk, size)?;
    Ok(promise)
}

/// WritableStreamDefaultWriterCloseWithErrorPropagation.
pub(crate) fn writer_close_with_error_propagation(cx: Ctx, w: Raw) -> R<V> {
    let s = writer(cx, w)?.stream.clone_ref();
    let state = state_of(cx, s.raw())?;
    if close_queued_or_in_flight(cx, s.raw())? || state == WState::Closed {
        return js::resolved(cx, js::UNDEFINED);
    }
    if state == WState::Errored {
        let e = stored_error(cx, s.raw())?;
        return js::rejected(cx, e.raw());
    }
    close_stream(cx, s.raw())
}

fn writer_stream(cx: Ctx, w: Raw) -> R<V> {
    let s = writer(cx, w)?.stream.clone_ref();
    if s.is_undefined() {
        return Err(js::type_error(cx, "the writer was released"));
    }
    Ok(s)
}

native!(
    fn writer_constructor(cx, this, args) {
        new_writer(cx, this, args.get(0))
    }
);

native!(
    fn writer_closed_get(cx, this, args) {
        writer_closed(cx, this)
    }
);

native!(
    fn writer_ready_get(cx, this, args) {
        writer_ready(cx, this)
    }
);

native!(
    fn writer_desired_size_get(cx, this, args) {
        let s = writer_stream(cx, this)?;
        Ok(match writer_desired_size(cx, s.raw())? {
            Some(n) => V::num(n),
            None => V::null(),
        })
    }
);

native!(
    fn writer_abort(cx, this, args) {
        js::promise_of(cx, || {
            let s = writer_stream(cx, this)?;
            abort_stream(cx, s.raw(), args.get(0))
        })
    }
);

native!(
    fn writer_close(cx, this, args) {
        js::promise_of(cx, || {
            let s = writer_stream(cx, this)?;
            if close_queued_or_in_flight(cx, s.raw())? {
                return Err(js::type_error(cx, "the stream is already closing"));
            }
            close_stream(cx, s.raw())
        })
    }
);

native!(
    fn writer_release_lock(cx, this, args) {
        writer_release(cx, this)?;
        Ok(V::undefined())
    }
);

native!(
    fn writer_write_method(cx, this, args) {
        js::promise_of(cx, || {
            writer_stream(cx, this)?;
            writer_write(cx, this, args.get(0))
        })
    }
);

// --- Controller -----------------------------------------------------------

fn clear_algorithms(cx: Ctx, c: Raw) -> R<()> {
    let old = {
        let mut ct = controller(cx, c)?;
        (
            std::mem::take(&mut ct.write),
            std::mem::take(&mut ct.close),
            std::mem::take(&mut ct.abort),
            ct.size.take_out(),
        )
    };
    drop(old);
    Ok(())
}

fn controller_desired_size(cx: Ctx, c: Raw) -> R<f64> {
    let ct = controller(cx, c)?;
    Ok(ct.hwm - ct.queue.total)
}

fn controller_chunk_size(cx: Ctx, c: Raw, chunk: Raw) -> R<f64> {
    let size = controller(cx, c)?.size.clone_ref();
    match chunk_size(cx, &size, chunk) {
        Ok(n) => Ok(n),
        Err(_) => {
            let e = js::take_exception(cx);
            error_if_needed(cx, c, e.raw())?;
            Ok(1.0)
        }
    }
}

/// WritableStreamDefaultControllerErrorIfNeeded.
pub(crate) fn error_if_needed(cx: Ctx, c: Raw, e: Raw) -> R<()> {
    let s = controller(cx, c)?.stream.clone_ref();
    if state_of(cx, s.raw())? == WState::Writable {
        controller_error(cx, c, e)?;
    }
    Ok(())
}

fn controller_error(cx: Ctx, c: Raw, e: Raw) -> R<()> {
    let s = controller(cx, c)?.stream.clone_ref();
    clear_algorithms(cx, c)?;
    start_erroring(cx, s.raw(), e)
}

fn controller_close(cx: Ctx, c: Raw) -> R<()> {
    let sentinel = instance(cx, js::UNDEFINED, Class::Internal, CloseSentinel)?;
    controller(cx, c)?.queue.enqueue(cx, sentinel, 0.0)?;
    advance_queue_if_needed(cx, c)
}

fn controller_write(cx: Ctx, c: Raw, chunk: Raw, size: f64) -> R<()> {
    let r = controller(cx, c)?
        .queue
        .enqueue(cx, V::dup(cx, chunk), size);
    if r.is_err() {
        let e = js::take_exception(cx);
        return error_if_needed(cx, c, e.raw());
    }
    let s = controller(cx, c)?.stream.clone_ref();
    if !close_queued_or_in_flight(cx, s.raw())? && state_of(cx, s.raw())? == WState::Writable {
        let bp = controller_desired_size(cx, c)? <= 0.0;
        update_backpressure(cx, s.raw(), bp)?;
    }
    advance_queue_if_needed(cx, c)
}

/// WritableStreamDefaultControllerAdvanceQueueIfNeeded.
fn advance_queue_if_needed(cx: Ctx, c: Raw) -> R<()> {
    let (s, started, next) = {
        let ct = controller(cx, c)?;
        (
            ct.stream.clone_ref(),
            ct.started,
            ct.queue.peek().map(V::clone_ref),
        )
    };
    if !started || stream(cx, s.raw())?.in_flight_write.is_some() {
        return Ok(());
    }
    let state = state_of(cx, s.raw())?;
    if matches!(state, WState::Closed | WState::Errored) {
        return Ok(());
    }
    if state == WState::Erroring {
        return finish_erroring(cx, s.raw());
    }
    let Some(next) = next else { return Ok(()) };
    if is::<CloseSentinel>(cx, next.raw()) {
        process_close(cx, c)
    } else {
        process_write(cx, c, next.raw())
    }
}

fn process_close(cx: Ctx, c: Raw) -> R<()> {
    let s = controller(cx, c)?.stream.clone_ref();
    {
        let mut st = stream(cx, s.raw())?;
        st.in_flight_close = st.close_request.take();
    }
    let (old, close) = {
        let mut ct = controller(cx, c)?;
        (ct.queue.dequeue(), ct.close.clone_ref())
    };
    drop(old);
    let p = close.promise(cx, &[])?;
    clear_algorithms(cx, c)?;
    js::upon(
        cx,
        p.raw(),
        vec![s],
        |cx, cap, _| finish_in_flight_close(cx, cap[0].raw()),
        |cx, cap, e| finish_in_flight_close_with_error(cx, cap[0].raw(), e),
    )
}

fn process_write(cx: Ctx, c: Raw, chunk: Raw) -> R<()> {
    let s = controller(cx, c)?.stream.clone_ref();
    {
        let mut st = stream(cx, s.raw())?;
        st.in_flight_write = st.write_requests.pop_front();
    }
    let write = controller(cx, c)?.write.clone_ref();
    let p = write.promise(cx, &[chunk, c])?;
    js::upon(
        cx,
        p.raw(),
        vec![s, V::dup(cx, c)],
        |cx, cap, _| {
            let (s, c) = (cap[0].raw(), cap[1].raw());
            finish_in_flight_write(cx, s)?;
            let old = controller(cx, c)?.queue.dequeue();
            drop(old);
            if !close_queued_or_in_flight(cx, s)? && state_of(cx, s)? == WState::Writable {
                let bp = controller_desired_size(cx, c)? <= 0.0;
                update_backpressure(cx, s, bp)?;
            }
            advance_queue_if_needed(cx, c)
        },
        |cx, cap, e| {
            let (s, c) = (cap[0].raw(), cap[1].raw());
            if state_of(cx, s)? == WState::Writable {
                clear_algorithms(cx, c)?;
            }
            finish_in_flight_write_with_error(cx, s, e)
        },
    )
}

/// The algorithms of an underlying sink.
pub(crate) struct Sink {
    pub(crate) start: Algo,
    pub(crate) write: Algo,
    pub(crate) close: Algo,
    pub(crate) abort: Algo,
}

/// SetUpWritableStreamDefaultController.
fn setup_controller(cx: Ctx, s: Raw, sink: Sink, hwm: f64, size: V) -> R<V> {
    let Sink {
        start,
        write,
        close,
        abort,
    } = sink;
    let g = js::global(cx);
    let ac = js::get(cx, g.raw(), "AbortController")?;
    let signal_controller = js::construct(cx, ac.raw(), &[])?;
    let c = instance(
        cx,
        js::UNDEFINED,
        Class::WritableStreamDefaultController,
        Controller {
            stream: V::dup(cx, s),
            queue: SizedQueue::default(),
            signal_controller,
            started: false,
            hwm,
            size,
            write,
            close,
            abort,
        },
    )?;
    stream(cx, s)?.controller = c.clone_ref();
    let bp = controller_desired_size(cx, c.raw())? <= 0.0;
    update_backpressure(cx, s, bp)?;
    let start_result = start.call(cx, &[c.raw()])?;
    let p = js::resolved(cx, start_result.raw())?;
    js::upon(
        cx,
        p.raw(),
        vec![c.clone_ref()],
        |cx, cap, _| {
            controller(cx, cap[0].raw())?.started = true;
            advance_queue_if_needed(cx, cap[0].raw())
        },
        |cx, cap, e| {
            let s = {
                let mut ct = controller(cx, cap[0].raw())?;
                ct.started = true;
                ct.stream.clone_ref()
            };
            deal_with_rejection(cx, s.raw(), e)
        },
    )?;
    Ok(c)
}

/// CreateWritableStream with native algorithms: the stream and its
/// controller.
pub(crate) fn new_writable_stream(cx: Ctx, sink: Sink, hwm: f64, size: V) -> R<(V, V)> {
    let s = new_stream(cx, js::UNDEFINED)?;
    let c = setup_controller(cx, s.raw(), sink, hwm, size)?;
    Ok((s, c))
}

native!(
    fn controller_signal(cx, this, args) {
        let ac = controller(cx, this)?.signal_controller.clone_ref();
        js::get(cx, ac.raw(), "signal")
    }
);

native!(
    fn controller_error_method(cx, this, args) {
        let s = controller(cx, this)?.stream.clone_ref();
        if state_of(cx, s.raw())? != WState::Writable {
            return Ok(V::undefined());
        }
        controller_error(cx, this, args.get(0))?;
        Ok(V::undefined())
    }
);

// --- WritableStream -------------------------------------------------------

native!(
    fn stream_constructor(cx, this, args) {
        let sink = args.get(0);
        if !js::is_nullish(sink) && !js::is_object(sink) {
            return Err(js::type_error(cx, "the underlying sink must be an object"));
        }
        let strategy = QueuingStrategy::read(cx, args.get(1))?;
        let sink_v = V::dup(cx, sink);
        let abort = method(cx, sink, "abort")?;
        let close = method(cx, sink, "close")?;
        let start = method(cx, sink, "start")?;
        if js::is_object(sink) {
            let t = js::get(cx, sink, "type")?;
            if !t.is_undefined() {
                return Err(js::range_error(cx, "an underlying sink has no type"));
            }
        }
        let write = method(cx, sink, "write")?;
        let hwm = strategy.high_water_mark(cx, 1.0)?;
        let s = new_stream(cx, this)?;
        let sink = Sink {
            start: Algo::method(start, &sink_v),
            write: Algo::method(write, &sink_v),
            close: Algo::method(close, &sink_v),
            abort: Algo::method(abort, &sink_v),
        };
        setup_controller(cx, s.raw(), sink, hwm, strategy.size)?;
        Ok(s)
    }
);

native!(
    fn stream_locked(cx, this, args) {
        Ok(V::bool(is_locked(cx, this)?))
    }
);

native!(
    fn stream_abort(cx, this, args) {
        js::promise_of(cx, || {
            if is_locked(cx, this)? {
                return Err(js::type_error(cx, "the WritableStream is locked"));
            }
            abort_stream(cx, this, args.get(0))
        })
    }
);

native!(
    fn stream_close(cx, this, args) {
        js::promise_of(cx, || {
            if is_locked(cx, this)? {
                return Err(js::type_error(cx, "the WritableStream is locked"));
            }
            if close_queued_or_in_flight(cx, this)? {
                return Err(js::type_error(cx, "the stream is already closing"));
            }
            close_stream(cx, this)
        })
    }
);

native!(
    fn stream_get_writer(cx, this, args) {
        acquire_writer(cx, this)
    }
);

pub(crate) const SPECS: &[Spec] = &[
    Spec {
        class: Class::WritableStream,
        name: c"WritableStream",
        parent: None,
        constructor: Some((stream_constructor, 0)),
        methods: &[
            (Key::Name(c"abort"), stream_abort, 0),
            (Key::Name(c"close"), stream_close, 0),
            (Key::Name(c"getWriter"), stream_get_writer, 0),
        ],
        accessors: &[(c"locked", stream_locked, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "<W = any>",
            members: r#"constructor(underlyingSink?: UnderlyingSink<W>, strategy?: QueuingStrategy<W>);
readonly locked: boolean;
abort(reason?: any): Promise<void>;
close(): Promise<void>;
getWriter(): WritableStreamDefaultWriter<W>;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::WritableStreamDefaultWriter,
        name: c"WritableStreamDefaultWriter",
        parent: None,
        constructor: Some((writer_constructor, 1)),
        methods: &[
            (Key::Name(c"abort"), writer_abort, 0),
            (Key::Name(c"close"), writer_close, 0),
            (Key::Name(c"releaseLock"), writer_release_lock, 0),
            (Key::Name(c"write"), writer_write_method, 0),
        ],
        accessors: &[
            (c"closed", writer_closed_get, None),
            (c"desiredSize", writer_desired_size_get, None),
            (c"ready", writer_ready_get, None),
        ],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "<W = any>",
            members: r#"constructor(stream: WritableStream<W>);
readonly closed: Promise<void>;
readonly desiredSize: number | null;
readonly ready: Promise<void>;
abort(reason?: any): Promise<void>;
close(): Promise<void>;
releaseLock(): void;
write(chunk?: W): Promise<void>;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::WritableStreamDefaultController,
        name: c"WritableStreamDefaultController",
        parent: None,
        constructor: None,
        methods: &[(Key::Name(c"error"), controller_error_method, 0)],
        accessors: &[(c"signal", controller_signal, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"readonly signal: AbortSignal;
error(e?: any): void;"#,
        }
        .declared(),
    },
];

/// The TypeScript types of this file's classes (`globals.d.ts`).
pub(crate) const TYPES: &str = r#"interface UnderlyingSink<W = any> {
  start?(controller: WritableStreamDefaultController): any;
  write?(chunk: W, controller: WritableStreamDefaultController): void | PromiseLike<void>;
  close?(): void | PromiseLike<void>;
  abort?(reason?: any): void | PromiseLike<void>;
  type?: undefined;
}
"#;
