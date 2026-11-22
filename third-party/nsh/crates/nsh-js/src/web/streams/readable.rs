//! `ReadableStream` and its readers and controllers (default and byte
//! streams), `tee`, `pipeTo`, `ReadableStream.from` and async iteration.
//! The functions are the standard's abstract operations, named after them.

use std::{cell::RefMut, collections::VecDeque, ffi::c_int};

use super::{
    Algo, QueuingStrategy, SizedQueue, chunk_size, method,
    writable::{self, WState},
};
use crate::web::{
    Class, Key, Object, Spec, data, instance, is,
    js::{self, Ctx, Deferred, R, Raw, V, native, trace},
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum State {
    Readable,
    Closed,
    Errored,
}

pub(crate) struct Stream {
    pub(crate) state: State,
    pub(crate) stored_error: V,
    reader: V,
    controller: V,
    disturbed: bool,
}

trace!(Stream {
    stored_error,
    reader,
    controller
});

impl Object for Stream {}

/// A pending read: `reader.read()`'s promise, or steps of an algorithm.
pub(crate) enum ReadRequest {
    Promise(Deferred),
    /// Functions of one argument each.
    Steps {
        chunk: V,
        close: V,
        error: V,
    },
}

impl js::Trace for ReadRequest {
    fn trace(&self, mark: &mut dyn FnMut(Raw)) {
        match self {
            ReadRequest::Promise(d) => d.trace(mark),
            ReadRequest::Steps {
                chunk,
                close,
                error,
            } => {
                chunk.trace(mark);
                close.trace(mark);
                error.trace(mark);
            }
        }
    }
}

impl ReadRequest {
    fn chunk(self, cx: Ctx, chunk: Raw) {
        let r = match self {
            ReadRequest::Promise(d) => {
                js::iter_result(cx, V::dup(cx, chunk), false).map(|r| d.resolve(cx, r.raw()))
            }
            ReadRequest::Steps { chunk: f, .. } => {
                js::call(cx, f.raw(), js::UNDEFINED, &[chunk]).map(drop)
            }
        };
        if r.is_err() {
            js::report_exception(cx);
        }
    }

    /// The end (`value`: undefined, or a read-into request's empty view).
    fn close(self, cx: Ctx, value: Raw) {
        let r = match self {
            ReadRequest::Promise(d) => {
                js::iter_result(cx, V::dup(cx, value), true).map(|r| d.resolve(cx, r.raw()))
            }
            ReadRequest::Steps { close, .. } => {
                js::call(cx, close.raw(), js::UNDEFINED, &[value]).map(drop)
            }
        };
        if r.is_err() {
            js::report_exception(cx);
        }
    }

    fn error(self, cx: Ctx, e: Raw) {
        let r = match self {
            ReadRequest::Promise(d) => {
                d.reject(cx, e);
                Ok(())
            }
            ReadRequest::Steps { error, .. } => {
                js::call(cx, error.raw(), js::UNDEFINED, &[e]).map(drop)
            }
        };
        if r.is_err() {
            js::report_exception(cx);
        }
    }

    /// A request of three Rust closures (each called with the argument).
    pub(crate) fn steps(
        cx: Ctx,
        captures: Vec<V>,
        chunk: impl Fn(Ctx, &[V], Raw) -> R<()> + 'static,
        close: impl Fn(Ctx, &[V], Raw) -> R<()> + 'static,
        error: impl Fn(Ctx, &[V], Raw) -> R<()> + 'static,
    ) -> R<ReadRequest> {
        let mk = |captures: Vec<V>, f: Step| {
            js::closure(cx, captures, move |cx, c, args| {
                f(cx, c, args.get(0))?;
                Ok(V::undefined())
            })
        };
        let clone = |c: &Vec<V>| c.iter().map(V::clone_ref).collect::<Vec<_>>();
        Ok(ReadRequest::Steps {
            chunk: mk(clone(&captures), Box::new(chunk))?,
            close: mk(clone(&captures), Box::new(close))?,
            error: mk(captures, Box::new(error))?,
        })
    }
}

/// A step of a read request in Rust.
type Step = Box<dyn Fn(Ctx, &[V], Raw) -> R<()>>;

/// What both readers have.
pub(crate) struct ReaderCommon {
    stream: V,
    closed: Deferred,
    requests: VecDeque<ReadRequest>,
}

trace!(ReaderCommon {
    stream,
    closed,
    requests
});

pub(crate) struct DefaultReader {
    common: ReaderCommon,
}

trace!(DefaultReader { common });

impl Object for DefaultReader {}

pub(crate) struct ByobReader {
    common: ReaderCommon,
}

trace!(ByobReader { common });

impl Object for ByobReader {}

pub(crate) struct DefaultController {
    stream: V,
    queue: SizedQueue,
    started: bool,
    close_requested: bool,
    pull_again: bool,
    pulling: bool,
    hwm: f64,
    size: V,
    pull: Algo,
    cancel: Algo,
}

trace!(DefaultController {
    stream,
    queue,
    size,
    pull,
    cancel
});

impl Object for DefaultController {}

/// A chunk in a byte stream's queue.
struct ByteChunk {
    buffer: V,
    offset: usize,
    len: usize,
}

trace!(ByteChunk { buffer });

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ReaderType {
    Default,
    Byob,
    None,
}

/// A pull-into descriptor (a BYOB read, or an auto-allocated one).
struct PullInto {
    buffer: V,
    buffer_len: usize,
    offset: usize,
    len: usize,
    filled: usize,
    min: usize,
    element: usize,
    /// The view's typed array kind (`None`: a DataView).
    kind: Option<c_int>,
    reader: ReaderType,
}

trace!(PullInto { buffer });

pub(crate) struct ByteController {
    stream: V,
    queue: VecDeque<ByteChunk>,
    total: usize,
    started: bool,
    close_requested: bool,
    pull_again: bool,
    pulling: bool,
    hwm: f64,
    auto_allocate: Option<usize>,
    pending: VecDeque<PullInto>,
    byob_request: V,
    pull: Algo,
    cancel: Algo,
}

trace!(ByteController {
    stream,
    queue,
    pending,
    byob_request,
    pull,
    cancel
});

impl Object for ByteController {}

pub(crate) struct ByobRequest {
    controller: V,
    view: V,
}

trace!(ByobRequest { controller, view });

impl Object for ByobRequest {}

// --- Access ---------------------------------------------------------------

pub(crate) fn stream<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, Stream>> {
    data::<Stream>(cx, v, "ReadableStream")
}

fn dc<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, DefaultController>> {
    data::<DefaultController>(cx, v, "ReadableStreamDefaultController")
}

fn bc<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, ByteController>> {
    data::<ByteController>(cx, v, "ReadableByteStreamController")
}

fn common<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, ReaderCommon>> {
    if is::<DefaultReader>(cx, v) {
        Ok(RefMut::map(data::<DefaultReader>(cx, v, "reader")?, |r| {
            &mut r.common
        }))
    } else {
        Ok(RefMut::map(
            data::<ByobReader>(cx, v, "ReadableStreamBYOBReader")?,
            |r| &mut r.common,
        ))
    }
}

pub(crate) fn is_stream(cx: Ctx, v: Raw) -> bool {
    is::<Stream>(cx, v)
}

fn is_byte_controller(cx: Ctx, v: Raw) -> bool {
    is::<ByteController>(cx, v)
}

fn state(cx: Ctx, s: Raw) -> R<State> {
    Ok(stream(cx, s)?.state)
}

pub(crate) fn state_of(cx: Ctx, s: Raw) -> R<State> {
    state(cx, s)
}

pub(crate) fn stored_error(cx: Ctx, s: Raw) -> R<V> {
    Ok(stream(cx, s)?.stored_error.clone_ref())
}

fn reader_of(cx: Ctx, s: Raw) -> R<V> {
    Ok(stream(cx, s)?.reader.clone_ref())
}

pub(crate) fn controller_of(cx: Ctx, s: Raw) -> R<V> {
    Ok(stream(cx, s)?.controller.clone_ref())
}

/// IsReadableStreamLocked.
pub(crate) fn is_locked(cx: Ctx, s: Raw) -> R<bool> {
    Ok(!stream(cx, s)?.reader.is_undefined())
}

/// Whether the stream was ever read or canceled.
pub(crate) fn is_disturbed(cx: Ctx, s: Raw) -> R<bool> {
    Ok(stream(cx, s)?.disturbed)
}

fn has_default_reader(cx: Ctx, s: Raw) -> R<bool> {
    let r = reader_of(cx, s)?;
    Ok(is::<DefaultReader>(cx, r.raw()))
}

fn has_byob_reader(cx: Ctx, s: Raw) -> R<bool> {
    let r = reader_of(cx, s)?;
    Ok(is::<ByobReader>(cx, r.raw()))
}

fn num_requests(cx: Ctx, s: Raw) -> R<usize> {
    let r = reader_of(cx, s)?;
    if r.is_undefined() {
        return Ok(0);
    }
    Ok(common(cx, r.raw())?.requests.len())
}

fn new_stream(cx: Ctx, new_target: Raw) -> R<V> {
    instance(
        cx,
        new_target,
        Class::ReadableStream,
        Stream {
            state: State::Readable,
            stored_error: V::undefined(),
            reader: V::undefined(),
            controller: V::undefined(),
            disturbed: false,
        },
    )
}

// --- Stream operations ----------------------------------------------------

/// ReadableStreamClose.
fn close_stream(cx: Ctx, s: Raw) -> R<()> {
    let reader = {
        let mut st = stream(cx, s)?;
        st.state = State::Closed;
        st.reader.clone_ref()
    };
    if reader.is_undefined() {
        return Ok(());
    }
    // A BYOB reader's requests are answered by its controller.
    let default = is::<DefaultReader>(cx, reader.raw());
    let (closed, requests) = {
        let mut c = common(cx, reader.raw())?;
        let requests = if default {
            std::mem::take(&mut c.requests)
        } else {
            VecDeque::new()
        };
        (c.closed.resolve.clone_ref(), requests)
    };
    let _ = js::call(cx, closed.raw(), js::UNDEFINED, &[js::UNDEFINED]);
    for r in requests {
        r.close(cx, js::UNDEFINED);
    }
    Ok(())
}

/// ReadableStreamError.
fn error_stream(cx: Ctx, s: Raw, e: Raw) -> R<()> {
    let reader = {
        let mut st = stream(cx, s)?;
        st.state = State::Errored;
        st.stored_error = V::dup(cx, e);
        st.reader.clone_ref()
    };
    if reader.is_undefined() {
        return Ok(());
    }
    let (closed, requests) = {
        let mut c = common(cx, reader.raw())?;
        (
            (c.closed.reject.clone_ref(), c.closed.promise.clone_ref()),
            std::mem::take(&mut c.requests),
        )
    };
    let _ = js::call(cx, closed.0.raw(), js::UNDEFINED, &[e]);
    js::mark_handled(cx, closed.1.raw());
    for r in requests {
        r.error(cx, e);
    }
    Ok(())
}

/// ReadableStreamCancel.
pub(crate) fn cancel_stream(cx: Ctx, s: Raw, reason: Raw) -> R<V> {
    let (st, err, reader, controller) = {
        let mut st = stream(cx, s)?;
        st.disturbed = true;
        (
            st.state,
            st.stored_error.clone_ref(),
            st.reader.clone_ref(),
            st.controller.clone_ref(),
        )
    };
    match st {
        State::Closed => return js::resolved(cx, js::UNDEFINED),
        State::Errored => return js::rejected(cx, err.raw()),
        State::Readable => {}
    }
    close_stream(cx, s)?;
    if !reader.is_undefined() && is::<ByobReader>(cx, reader.raw()) {
        let requests = std::mem::take(&mut common(cx, reader.raw())?.requests);
        for r in requests {
            r.close(cx, js::UNDEFINED);
        }
    }
    let source_cancel = if is_byte_controller(cx, controller.raw()) {
        bc_cancel_steps(cx, controller.raw(), reason)?
    } else {
        dc_cancel_steps(cx, controller.raw(), reason)?
    };
    let undefined = js::closure(cx, Vec::new(), |_, _, _| Ok(V::undefined()))?;
    js::then(cx, source_cancel.raw(), undefined.raw(), js::UNDEFINED)
}

fn add_request(cx: Ctx, s: Raw, request: ReadRequest) -> R<()> {
    let reader = reader_of(cx, s)?;
    common(cx, reader.raw())?.requests.push_back(request);
    Ok(())
}

/// ReadableStreamFulfillReadRequest / ReadIntoRequest.
fn fulfill_request(cx: Ctx, s: Raw, chunk: Raw, done: bool) -> R<()> {
    let reader = reader_of(cx, s)?;
    let request = common(cx, reader.raw())?.requests.pop_front();
    if let Some(r) = request {
        if done {
            r.close(cx, chunk);
        } else {
            r.chunk(cx, chunk);
        }
    }
    Ok(())
}

// --- Default controller ---------------------------------------------------

fn dc_stream(cx: Ctx, c: Raw) -> R<V> {
    Ok(dc(cx, c)?.stream.clone_ref())
}

/// ReadableStreamDefaultControllerCanCloseOrEnqueue.
pub(crate) fn dc_can_close_or_enqueue(cx: Ctx, c: Raw) -> R<bool> {
    let (close_requested, s) = {
        let d = dc(cx, c)?;
        (d.close_requested, d.stream.clone_ref())
    };
    Ok(!close_requested && state(cx, s.raw())? == State::Readable)
}

/// ReadableStreamDefaultControllerGetDesiredSize.
pub(crate) fn dc_desired_size(cx: Ctx, c: Raw) -> R<Option<f64>> {
    let (hwm, total, s) = {
        let d = dc(cx, c)?;
        (d.hwm, d.queue.total, d.stream.clone_ref())
    };
    Ok(match state(cx, s.raw())? {
        State::Errored => None,
        State::Closed => Some(0.0),
        State::Readable => Some(hwm - total),
    })
}

fn dc_should_call_pull(cx: Ctx, c: Raw) -> R<bool> {
    if !dc_can_close_or_enqueue(cx, c)? {
        return Ok(false);
    }
    let (started, s) = {
        let d = dc(cx, c)?;
        (d.started, d.stream.clone_ref())
    };
    if !started {
        return Ok(false);
    }
    if is_locked(cx, s.raw())? && num_requests(cx, s.raw())? > 0 {
        return Ok(true);
    }
    Ok(dc_desired_size(cx, c)?.is_some_and(|d| d > 0.0))
}

/// ReadableStreamDefaultControllerHasBackpressure.
pub(crate) fn dc_has_backpressure(cx: Ctx, c: Raw) -> R<bool> {
    Ok(!dc_should_call_pull(cx, c)?)
}

fn dc_clear_algorithms(cx: Ctx, c: Raw) -> R<()> {
    let old = {
        let mut d = dc(cx, c)?;
        (
            std::mem::take(&mut d.pull),
            std::mem::take(&mut d.cancel),
            d.size.take_out(),
        )
    };
    drop(old);
    Ok(())
}

fn dc_call_pull_if_needed(cx: Ctx, c: Raw) -> R<()> {
    if !dc_should_call_pull(cx, c)? {
        return Ok(());
    }
    let pull = {
        let mut d = dc(cx, c)?;
        if d.pulling {
            d.pull_again = true;
            return Ok(());
        }
        d.pulling = true;
        d.pull.clone_ref()
    };
    let p = pull.promise(cx, &[c])?;
    js::upon(
        cx,
        p.raw(),
        vec![V::dup(cx, c)],
        |cx, cap, _| {
            let again = {
                let mut d = dc(cx, cap[0].raw())?;
                d.pulling = false;
                std::mem::replace(&mut d.pull_again, false)
            };
            if again {
                dc_call_pull_if_needed(cx, cap[0].raw())?;
            }
            Ok(())
        },
        |cx, cap, e| dc_error(cx, cap[0].raw(), e),
    )
}

/// ReadableStreamDefaultControllerClose.
pub(crate) fn dc_close(cx: Ctx, c: Raw) -> R<()> {
    if !dc_can_close_or_enqueue(cx, c)? {
        return Ok(());
    }
    let (empty, s) = {
        let mut d = dc(cx, c)?;
        d.close_requested = true;
        (d.queue.is_empty(), d.stream.clone_ref())
    };
    if empty {
        dc_clear_algorithms(cx, c)?;
        close_stream(cx, s.raw())?;
    }
    Ok(())
}

/// ReadableStreamDefaultControllerEnqueue.
pub(crate) fn dc_enqueue(cx: Ctx, c: Raw, chunk: Raw) -> R<()> {
    if !dc_can_close_or_enqueue(cx, c)? {
        return Ok(());
    }
    let s = dc_stream(cx, c)?;
    if is_locked(cx, s.raw())? && num_requests(cx, s.raw())? > 0 {
        fulfill_request(cx, s.raw(), chunk, false)?;
    } else {
        let size = dc(cx, c)?.size.clone_ref();
        let n = match chunk_size(cx, &size, chunk) {
            Ok(n) => n,
            Err(t) => {
                let e = js::take_exception(cx);
                dc_error(cx, c, e.raw())?;
                return Err(js::throw(cx, e)).or(Err(t));
            }
        };
        let r = dc(cx, c)?.queue.enqueue(cx, V::dup(cx, chunk), n);
        if let Err(t) = r {
            let e = js::take_exception(cx);
            dc_error(cx, c, e.raw())?;
            return Err(js::throw(cx, e)).or(Err(t));
        }
    }
    dc_call_pull_if_needed(cx, c)
}

/// ReadableStreamDefaultControllerError.
pub(crate) fn dc_error(cx: Ctx, c: Raw, e: Raw) -> R<()> {
    let s = dc_stream(cx, c)?;
    if state(cx, s.raw())? != State::Readable {
        return Ok(());
    }
    let old = dc(cx, c)?.queue.reset();
    drop(old);
    dc_clear_algorithms(cx, c)?;
    error_stream(cx, s.raw(), e)
}

fn dc_cancel_steps(cx: Ctx, c: Raw, reason: Raw) -> R<V> {
    let (old, cancel) = {
        let mut d = dc(cx, c)?;
        (d.queue.reset(), d.cancel.clone_ref())
    };
    drop(old);
    let result = cancel.promise(cx, &[reason])?;
    dc_clear_algorithms(cx, c)?;
    Ok(result)
}

fn dc_pull_steps(cx: Ctx, c: Raw, request: ReadRequest) -> R<()> {
    let (chunk, s, close_requested, empty) = {
        let mut d = dc(cx, c)?;
        let chunk = d.queue.dequeue();
        (
            chunk,
            d.stream.clone_ref(),
            d.close_requested,
            d.queue.is_empty(),
        )
    };
    match chunk {
        Some(chunk) => {
            if close_requested && empty {
                dc_clear_algorithms(cx, c)?;
                close_stream(cx, s.raw())?;
            } else {
                dc_call_pull_if_needed(cx, c)?;
            }
            request.chunk(cx, chunk.raw());
        }
        None => {
            add_request(cx, s.raw(), request)?;
            dc_call_pull_if_needed(cx, c)?;
        }
    }
    Ok(())
}

/// SetUpReadableStreamDefaultController.
fn setup_default_controller(
    cx: Ctx,
    s: Raw,
    start: Algo,
    pull: Algo,
    cancel: Algo,
    hwm: f64,
    size: V,
) -> R<V> {
    let c = instance(
        cx,
        js::UNDEFINED,
        Class::ReadableStreamDefaultController,
        DefaultController {
            stream: V::dup(cx, s),
            queue: SizedQueue::default(),
            started: false,
            close_requested: false,
            pull_again: false,
            pulling: false,
            hwm,
            size,
            pull,
            cancel,
        },
    )?;
    stream(cx, s)?.controller = c.clone_ref();
    let start_result = start.call(cx, &[c.raw()])?;
    let p = js::resolved(cx, start_result.raw())?;
    js::upon(
        cx,
        p.raw(),
        vec![c.clone_ref()],
        |cx, cap, _| {
            dc(cx, cap[0].raw())?.started = true;
            dc_call_pull_if_needed(cx, cap[0].raw())
        },
        |cx, cap, e| dc_error(cx, cap[0].raw(), e),
    )?;
    Ok(c)
}

/// CreateReadableStream: a default stream with native algorithms.
pub(crate) fn new_default_stream(
    cx: Ctx,
    start: Algo,
    pull: Algo,
    cancel: Algo,
    hwm: f64,
    size: V,
) -> R<(V, V)> {
    let s = new_stream(cx, js::UNDEFINED)?;
    let c = setup_default_controller(cx, s.raw(), start, pull, cancel, hwm, size)?;
    Ok((s, c))
}

// --- Byte controller ------------------------------------------------------

fn bc_stream(cx: Ctx, c: Raw) -> R<V> {
    Ok(bc(cx, c)?.stream.clone_ref())
}

/// ReadableByteStreamControllerGetDesiredSize.
fn bc_desired_size(cx: Ctx, c: Raw) -> R<Option<f64>> {
    let (hwm, total, s) = {
        let b = bc(cx, c)?;
        (b.hwm, b.total, b.stream.clone_ref())
    };
    Ok(match state(cx, s.raw())? {
        State::Errored => None,
        State::Closed => Some(0.0),
        State::Readable => Some(hwm - total as f64),
    })
}

/// The desired size of either controller (`None`: errored).
pub(crate) fn desired_size(cx: Ctx, c: Raw) -> R<Option<f64>> {
    if is_byte_controller(cx, c) {
        bc_desired_size(cx, c)
    } else {
        dc_desired_size(cx, c)
    }
}

fn bc_should_call_pull(cx: Ctx, c: Raw) -> R<bool> {
    let (s, close_requested, started) = {
        let b = bc(cx, c)?;
        (b.stream.clone_ref(), b.close_requested, b.started)
    };
    if state(cx, s.raw())? != State::Readable || close_requested || !started {
        return Ok(false);
    }
    if (has_default_reader(cx, s.raw())? || has_byob_reader(cx, s.raw())?)
        && num_requests(cx, s.raw())? > 0
    {
        return Ok(true);
    }
    Ok(bc_desired_size(cx, c)?.is_some_and(|d| d > 0.0))
}

fn bc_call_pull_if_needed(cx: Ctx, c: Raw) -> R<()> {
    if !bc_should_call_pull(cx, c)? {
        return Ok(());
    }
    let pull = {
        let mut b = bc(cx, c)?;
        if b.pulling {
            b.pull_again = true;
            return Ok(());
        }
        b.pulling = true;
        b.pull.clone_ref()
    };
    let p = pull.promise(cx, &[c])?;
    js::upon(
        cx,
        p.raw(),
        vec![V::dup(cx, c)],
        |cx, cap, _| {
            let again = {
                let mut b = bc(cx, cap[0].raw())?;
                b.pulling = false;
                std::mem::replace(&mut b.pull_again, false)
            };
            if again {
                bc_call_pull_if_needed(cx, cap[0].raw())?;
            }
            Ok(())
        },
        |cx, cap, e| bc_error(cx, cap[0].raw(), e),
    )
}

fn bc_clear_algorithms(cx: Ctx, c: Raw) -> R<()> {
    let old = {
        let mut b = bc(cx, c)?;
        (std::mem::take(&mut b.pull), std::mem::take(&mut b.cancel))
    };
    drop(old);
    Ok(())
}

fn bc_invalidate_byob_request(cx: Ctx, c: Raw) -> R<()> {
    let request = bc(cx, c)?.byob_request.take_out();
    if request.is_undefined() || request.is_nullish() {
        return Ok(());
    }
    let old = {
        let mut r = data::<ByobRequest>(cx, request.raw(), "ReadableStreamBYOBRequest")?;
        (
            r.controller.take_out(),
            std::mem::replace(&mut r.view, V::null()),
        )
    };
    drop(old);
    Ok(())
}

fn bc_clear_pending(cx: Ctx, c: Raw) -> R<()> {
    bc_invalidate_byob_request(cx, c)?;
    let old = std::mem::take(&mut bc(cx, c)?.pending);
    drop(old);
    Ok(())
}

fn bc_reset_queue(cx: Ctx, c: Raw) -> R<()> {
    let old = {
        let mut b = bc(cx, c)?;
        b.total = 0;
        std::mem::take(&mut b.queue)
    };
    drop(old);
    Ok(())
}

/// ReadableByteStreamControllerError.
pub(crate) fn bc_error(cx: Ctx, c: Raw, e: Raw) -> R<()> {
    let s = bc_stream(cx, c)?;
    if state(cx, s.raw())? != State::Readable {
        return Ok(());
    }
    bc_clear_pending(cx, c)?;
    bc_reset_queue(cx, c)?;
    bc_clear_algorithms(cx, c)?;
    error_stream(cx, s.raw(), e)
}

/// ReadableByteStreamControllerClose.
pub(crate) fn bc_close(cx: Ctx, c: Raw) -> R<()> {
    let s = bc_stream(cx, c)?;
    let (close_requested, total, misaligned) = {
        let b = bc(cx, c)?;
        let misaligned = b.pending.front().is_some_and(|p| p.filled % p.element != 0);
        (b.close_requested, b.total, misaligned)
    };
    if close_requested || state(cx, s.raw())? != State::Readable {
        return Ok(());
    }
    if total > 0 {
        bc(cx, c)?.close_requested = true;
        return Ok(());
    }
    if misaligned {
        let e = js::type_error_value(cx, "a partial element is left in the BYOB request");
        bc_error(cx, c, e.raw())?;
        return Err(js::throw(cx, e));
    }
    bc_clear_algorithms(cx, c)?;
    close_stream(cx, s.raw())
}

fn bc_enqueue_chunk(cx: Ctx, c: Raw, buffer: V, offset: usize, len: usize) -> R<()> {
    let mut b = bc(cx, c)?;
    b.queue.push_back(ByteChunk {
        buffer,
        offset,
        len,
    });
    b.total += len;
    Ok(())
}

fn bc_enqueue_cloned_chunk(cx: Ctx, c: Raw, buffer: Raw, offset: usize, len: usize) -> R<()> {
    // SAFETY: copied before any JS runs.
    let bytes = unsafe { js::bytes_of(cx, buffer) }
        .and_then(|b| b.get(offset..offset + len))
        .map(<[u8]>::to_vec);
    let Some(bytes) = bytes else {
        let e = js::type_error_value(cx, "the buffer is detached");
        bc_error(cx, c, e.raw())?;
        return Err(js::throw(cx, e));
    };
    let clone = js::array_buffer(cx, &bytes)?;
    bc_enqueue_chunk(cx, c, clone, 0, len)
}

fn bc_shift_pending(cx: Ctx, c: Raw) -> R<Option<PullInto>> {
    Ok(bc(cx, c)?.pending.pop_front())
}

/// ReadableByteStreamControllerEnqueueDetachedPullIntoToQueue.
fn bc_enqueue_detached_pull_into(cx: Ctx, c: Raw) -> R<()> {
    let first = bc(cx, c)?
        .pending
        .front()
        .map(|p| (p.buffer.clone_ref(), p.offset, p.filled));
    if let Some((buffer, offset, filled)) = first
        && filled > 0
    {
        bc_enqueue_cloned_chunk(cx, c, buffer.raw(), offset, filled)?;
    }
    bc_shift_pending(cx, c)?;
    Ok(())
}

/// ReadableByteStreamControllerFillPullIntoDescriptorFromQueue (on the
/// first pending descriptor, or `desc`).
fn bc_fill_from_queue(cx: Ctx, c: Raw, desc: &mut PullInto) -> R<bool> {
    let mut b = bc(cx, c)?;
    let max_copy = b.total.min(desc.len - desc.filled);
    let max_filled = desc.filled + max_copy;
    let mut remaining = max_copy;
    let mut ready = false;
    let aligned = max_filled - max_filled % desc.element;
    if aligned >= desc.min {
        remaining = aligned - desc.filled;
        ready = true;
    }
    while remaining > 0 {
        let Some(head) = b.queue.front_mut() else {
            break;
        };
        let n = remaining.min(head.len);
        let dest = desc.offset + desc.filled;
        // SAFETY: two distinct buffers (a chunk was transferred into the
        // queue), copied before any JS runs.
        unsafe {
            let src = js::bytes_of(cx, head.buffer.raw()).unwrap_or_default();
            let dst = js::bytes_mut(cx, desc.buffer.raw()).unwrap_or_default();
            if let (Some(s), Some(d)) = (
                src.get(head.offset..head.offset + n),
                dst.get_mut(dest..dest + n),
            ) {
                d.copy_from_slice(s);
            }
        }
        if head.len == n {
            let gone = b.queue.pop_front();
            drop(gone);
        } else {
            head.offset += n;
            head.len -= n;
        }
        b.total -= n;
        desc.filled += n;
        remaining -= n;
    }
    Ok(ready)
}

/// ReadableByteStreamControllerConvertPullIntoDescriptor.
fn convert_pull_into(cx: Ctx, desc: &PullInto) -> R<V> {
    let buffer = js::transfer(cx, desc.buffer.raw())?;
    let length = if desc.kind.is_some() {
        desc.filled / desc.element
    } else {
        desc.filled
    };
    js::new_view(cx, desc.kind, buffer.raw(), desc.offset, length)
}

/// ReadableByteStreamControllerHandleQueueDrain.
fn bc_handle_queue_drain(cx: Ctx, c: Raw) -> R<()> {
    let (total, close_requested, s) = {
        let b = bc(cx, c)?;
        (b.total, b.close_requested, b.stream.clone_ref())
    };
    if total == 0 && close_requested {
        bc_clear_algorithms(cx, c)?;
        close_stream(cx, s.raw())
    } else {
        bc_call_pull_if_needed(cx, c)
    }
}

/// ReadableByteStreamControllerFillReadRequestFromQueue.
fn bc_fill_read_request(cx: Ctx, c: Raw, request: ReadRequest) -> R<()> {
    let entry = {
        let mut b = bc(cx, c)?;
        let e = b.queue.pop_front();
        if let Some(e) = &e {
            b.total -= e.len;
        }
        e
    };
    let Some(entry) = entry else { return Ok(()) };
    bc_handle_queue_drain(cx, c)?;
    let view = js::new_view(
        cx,
        Some(rquickjs::qjs::JSTypedArrayEnum_JS_TYPED_ARRAY_UINT8 as c_int),
        entry.buffer.raw(),
        entry.offset,
        entry.len,
    )?;
    request.chunk(cx, view.raw());
    Ok(())
}

/// ReadableByteStreamControllerProcessReadRequestsUsingQueue.
fn bc_process_read_requests(cx: Ctx, c: Raw) -> R<()> {
    let s = bc_stream(cx, c)?;
    loop {
        let reader = reader_of(cx, s.raw())?;
        if reader.is_undefined() || bc(cx, c)?.total == 0 {
            return Ok(());
        }
        let Some(request) = common(cx, reader.raw())?.requests.pop_front() else {
            return Ok(());
        };
        bc_fill_read_request(cx, c, request)?;
    }
}

/// ReadableByteStreamControllerProcessPullIntoDescriptorsUsingQueue.
fn bc_process_pull_intos(cx: Ctx, c: Raw) -> R<Vec<PullInto>> {
    let mut filled = Vec::new();
    loop {
        if bc(cx, c)?.total == 0 {
            break;
        }
        let Some(mut desc) = bc(cx, c)?.pending.pop_front() else {
            break;
        };
        if bc_fill_from_queue(cx, c, &mut desc)? {
            filled.push(desc);
        } else {
            bc(cx, c)?.pending.push_front(desc);
            break;
        }
    }
    Ok(filled)
}

/// ReadableByteStreamControllerCommitPullIntoDescriptor.
fn commit_pull_into(cx: Ctx, s: Raw, desc: PullInto) -> R<()> {
    let done = state(cx, s)? == State::Closed;
    let view = convert_pull_into(cx, &desc)?;
    fulfill_request(cx, s, view.raw(), done)
}

/// ReadableByteStreamControllerEnqueue.
pub(crate) fn bc_enqueue(cx: Ctx, c: Raw, chunk: Raw) -> R<()> {
    let s = bc_stream(cx, c)?;
    if bc(cx, c)?.close_requested || state(cx, s.raw())? != State::Readable {
        return Ok(());
    }
    let view = js::view(cx, chunk)
        .ok_or_else(|| js::type_error(cx, "chunk must be an ArrayBufferView"))?;
    if js::is_detached(cx, view.buffer.raw()) {
        return Err(js::type_error(cx, "the chunk's buffer is detached"));
    }
    let (offset, len) = (view.offset, view.length);
    let transferred = js::transfer(cx, view.buffer.raw())?;
    let first = bc(cx, c)?
        .pending
        .front()
        .map(|p| (p.buffer.clone_ref(), p.reader));
    if let Some((buffer, reader_type)) = first {
        if js::is_detached(cx, buffer.raw()) {
            return Err(js::type_error(cx, "the BYOB request's buffer is detached"));
        }
        bc_invalidate_byob_request(cx, c)?;
        let moved = js::transfer(cx, buffer.raw())?;
        if let Some(p) = bc(cx, c)?.pending.front_mut() {
            p.buffer = moved;
        }
        if reader_type == ReaderType::None {
            bc_enqueue_detached_pull_into(cx, c)?;
        }
    }
    if has_default_reader(cx, s.raw())? {
        bc_process_read_requests(cx, c)?;
        if num_requests(cx, s.raw())? == 0 {
            bc_enqueue_chunk(cx, c, transferred, offset, len)?;
        } else {
            if !bc(cx, c)?.pending.is_empty() {
                bc_shift_pending(cx, c)?;
            }
            let view = js::new_view(
                cx,
                Some(rquickjs::qjs::JSTypedArrayEnum_JS_TYPED_ARRAY_UINT8 as c_int),
                transferred.raw(),
                offset,
                len,
            )?;
            fulfill_request(cx, s.raw(), view.raw(), false)?;
        }
    } else if has_byob_reader(cx, s.raw())? {
        bc_enqueue_chunk(cx, c, transferred, offset, len)?;
        for desc in bc_process_pull_intos(cx, c)? {
            commit_pull_into(cx, s.raw(), desc)?;
        }
    } else {
        bc_enqueue_chunk(cx, c, transferred, offset, len)?;
    }
    bc_call_pull_if_needed(cx, c)
}

/// ReadableByteStreamControllerGetBYOBRequest.
fn bc_byob_request(cx: Ctx, c: Raw) -> R<V> {
    let (existing, first) = {
        let b = bc(cx, c)?;
        (
            b.byob_request.clone_ref(),
            b.pending
                .front()
                .map(|p| (p.buffer.clone_ref(), p.offset + p.filled, p.len - p.filled)),
        )
    };
    if !existing.is_nullish() {
        return Ok(existing);
    }
    let Some((buffer, offset, len)) = first else {
        return Ok(V::null());
    };
    let view = js::new_view(
        cx,
        Some(rquickjs::qjs::JSTypedArrayEnum_JS_TYPED_ARRAY_UINT8 as c_int),
        buffer.raw(),
        offset,
        len,
    )?;
    let request = instance(
        cx,
        js::UNDEFINED,
        Class::ReadableStreamBYOBRequest,
        ByobRequest {
            controller: V::dup(cx, c),
            view,
        },
    )?;
    bc(cx, c)?.byob_request = request.clone_ref();
    Ok(request)
}

fn bc_fill_head(cx: Ctx, c: Raw, size: usize) -> R<()> {
    if let Some(p) = bc(cx, c)?.pending.front_mut() {
        p.filled += size;
    }
    Ok(())
}

/// ReadableByteStreamControllerRespondInClosedState.
fn bc_respond_closed(cx: Ctx, c: Raw) -> R<()> {
    let reader_type = bc(cx, c)?.pending.front().map(|p| p.reader);
    if reader_type == Some(ReaderType::None) {
        bc_shift_pending(cx, c)?;
    }
    let s = bc_stream(cx, c)?;
    if has_byob_reader(cx, s.raw())? {
        let mut filled = Vec::new();
        while filled.len() < num_requests(cx, s.raw())? {
            match bc_shift_pending(cx, c)? {
                Some(d) => filled.push(d),
                None => break,
            }
        }
        for desc in filled {
            commit_pull_into(cx, s.raw(), desc)?;
        }
    }
    Ok(())
}

/// ReadableByteStreamControllerRespondInReadableState.
fn bc_respond_readable(cx: Ctx, c: Raw, written: usize) -> R<()> {
    bc_fill_head(cx, c, written)?;
    let s = bc_stream(cx, c)?;
    let (reader_type, filled, min) = {
        let b = bc(cx, c)?;
        let p = b
            .pending
            .front()
            .ok_or_else(|| js::type_error(cx, "no pending read"))?;
        (p.reader, p.filled, p.min)
    };
    if reader_type == ReaderType::None {
        bc_enqueue_detached_pull_into(cx, c)?;
        for desc in bc_process_pull_intos(cx, c)? {
            commit_pull_into(cx, s.raw(), desc)?;
        }
        return Ok(());
    }
    if filled < min {
        return Ok(());
    }
    let Some(mut desc) = bc_shift_pending(cx, c)? else {
        return Ok(());
    };
    let remainder = desc.filled % desc.element;
    if remainder > 0 {
        let end = desc.offset + desc.filled;
        bc_enqueue_cloned_chunk(cx, c, desc.buffer.raw(), end - remainder, remainder)?;
    }
    desc.filled -= remainder;
    let filled = bc_process_pull_intos(cx, c)?;
    commit_pull_into(cx, s.raw(), desc)?;
    for d in filled {
        commit_pull_into(cx, s.raw(), d)?;
    }
    Ok(())
}

/// ReadableByteStreamControllerRespondInternal.
fn bc_respond_internal(cx: Ctx, c: Raw, written: usize) -> R<()> {
    bc_invalidate_byob_request(cx, c)?;
    let s = bc_stream(cx, c)?;
    if state(cx, s.raw())? == State::Closed {
        bc_respond_closed(cx, c)?;
    } else {
        bc_respond_readable(cx, c, written)?;
    }
    bc_call_pull_if_needed(cx, c)
}

/// ReadableByteStreamControllerRespond.
fn bc_respond(cx: Ctx, c: Raw, written: usize) -> R<()> {
    let s = bc_stream(cx, c)?;
    let (buffer, filled, len) = {
        let b = bc(cx, c)?;
        let p = b
            .pending
            .front()
            .ok_or_else(|| js::type_error(cx, "no pending read"))?;
        (p.buffer.clone_ref(), p.filled, p.len)
    };
    if state(cx, s.raw())? == State::Closed {
        if written != 0 {
            return Err(js::type_error(
                cx,
                "bytesWritten must be 0 for a closed stream",
            ));
        }
    } else {
        if written == 0 {
            return Err(js::type_error(cx, "bytesWritten must be greater than 0"));
        }
        if filled + written > len {
            return Err(js::range_error(cx, "bytesWritten is out of range"));
        }
    }
    let moved = js::transfer(cx, buffer.raw())?;
    if let Some(p) = bc(cx, c)?.pending.front_mut() {
        p.buffer = moved;
    }
    bc_respond_internal(cx, c, written)
}

/// ReadableByteStreamControllerRespondWithNewView.
fn bc_respond_with_new_view(cx: Ctx, c: Raw, view: Raw) -> R<()> {
    let v =
        js::view(cx, view).ok_or_else(|| js::type_error(cx, "view must be an ArrayBufferView"))?;
    if js::is_detached(cx, v.buffer.raw()) {
        return Err(js::type_error(cx, "the view's buffer is detached"));
    }
    let s = bc_stream(cx, c)?;
    let (offset, filled, buffer_len, len) = {
        let b = bc(cx, c)?;
        let p = b
            .pending
            .front()
            .ok_or_else(|| js::type_error(cx, "no pending read"))?;
        (p.offset, p.filled, p.buffer_len, p.len)
    };
    let closed = state(cx, s.raw())? == State::Closed;
    if closed && v.length != 0 {
        return Err(js::type_error(
            cx,
            "the view must be empty for a closed stream",
        ));
    }
    if !closed && v.length == 0 {
        return Err(js::type_error(cx, "the view must not be empty"));
    }
    // SAFETY: reading a live ArrayBuffer's length.
    let view_buffer_len = unsafe { js::bytes_of(cx, v.buffer.raw()) }.map_or(0, <[u8]>::len);
    if offset + filled != v.offset {
        return Err(js::range_error(
            cx,
            "the view's offset does not match the request",
        ));
    }
    if buffer_len != view_buffer_len {
        return Err(js::range_error(
            cx,
            "the view's buffer length does not match the request",
        ));
    }
    if filled + v.length > len {
        return Err(js::range_error(cx, "the view is too long"));
    }
    let moved = js::transfer(cx, v.buffer.raw())?;
    if let Some(p) = bc(cx, c)?.pending.front_mut() {
        p.buffer = moved;
    }
    bc_respond_internal(cx, c, v.length)
}

fn bc_cancel_steps(cx: Ctx, c: Raw, reason: Raw) -> R<V> {
    bc_clear_pending(cx, c)?;
    bc_reset_queue(cx, c)?;
    let cancel = bc(cx, c)?.cancel.clone_ref();
    let result = cancel.promise(cx, &[reason])?;
    bc_clear_algorithms(cx, c)?;
    Ok(result)
}

fn bc_pull_steps(cx: Ctx, c: Raw, request: ReadRequest) -> R<()> {
    let s = bc_stream(cx, c)?;
    if bc(cx, c)?.total > 0 {
        return bc_fill_read_request(cx, c, request);
    }
    let auto_allocate = bc(cx, c)?.auto_allocate;
    if let Some(size) = auto_allocate {
        let buffer = match js::array_buffer(cx, &vec![0; size]) {
            Ok(b) => b,
            Err(_) => {
                let e = js::take_exception(cx);
                request.error(cx, e.raw());
                return Ok(());
            }
        };
        bc(cx, c)?.pending.push_back(PullInto {
            buffer,
            buffer_len: size,
            offset: 0,
            len: size,
            filled: 0,
            min: 1,
            element: 1,
            kind: Some(rquickjs::qjs::JSTypedArrayEnum_JS_TYPED_ARRAY_UINT8 as c_int),
            reader: ReaderType::Default,
        });
    }
    add_request(cx, s.raw(), request)?;
    bc_call_pull_if_needed(cx, c)
}

fn bc_release_steps(cx: Ctx, c: Raw) -> R<()> {
    let mut b = bc(cx, c)?;
    if let Some(mut first) = b.pending.pop_front() {
        first.reader = ReaderType::None;
        let rest = std::mem::take(&mut b.pending);
        b.pending.push_back(first);
        drop(b);
        drop(rest);
    }
    Ok(())
}

/// ReadableByteStreamControllerPullInto.
fn bc_pull_into(cx: Ctx, c: Raw, view: Raw, min: usize, request: ReadRequest) -> R<()> {
    let s = bc_stream(cx, c)?;
    let v =
        js::view(cx, view).ok_or_else(|| js::type_error(cx, "view must be an ArrayBufferView"))?;
    let (element, kind) = match v.kind {
        Some(k) => (v.element.max(1), Some(k)),
        None => (1, None),
    };
    let buffer = match js::transfer(cx, v.buffer.raw()) {
        Ok(b) => b,
        Err(_) => {
            let e = js::take_exception(cx);
            request.error(cx, e.raw());
            return Ok(());
        }
    };
    // SAFETY: reading the new buffer's length.
    let buffer_len = unsafe { js::bytes_of(cx, buffer.raw()) }.map_or(0, <[u8]>::len);
    let mut desc = PullInto {
        buffer,
        buffer_len,
        offset: v.offset,
        len: v.length,
        filled: 0,
        min: min * element,
        element,
        kind,
        reader: ReaderType::Byob,
    };
    if !bc(cx, c)?.pending.is_empty() {
        bc(cx, c)?.pending.push_back(desc);
        return add_request(cx, s.raw(), request);
    }
    if state(cx, s.raw())? == State::Closed {
        let empty = js::new_view(cx, kind, desc.buffer.raw(), desc.offset, 0)?;
        request.close(cx, empty.raw());
        return Ok(());
    }
    if bc(cx, c)?.total > 0 {
        if bc_fill_from_queue(cx, c, &mut desc)? {
            let filled = convert_pull_into(cx, &desc)?;
            bc_handle_queue_drain(cx, c)?;
            request.chunk(cx, filled.raw());
            return Ok(());
        }
        if bc(cx, c)?.close_requested {
            let e = js::type_error_value(cx, "the stream is closing");
            bc_error(cx, c, e.raw())?;
            request.error(cx, e.raw());
            return Ok(());
        }
    }
    bc(cx, c)?.pending.push_back(desc);
    add_request(cx, s.raw(), request)?;
    bc_call_pull_if_needed(cx, c)
}

/// SetUpReadableByteStreamController.
fn setup_byte_controller(
    cx: Ctx,
    s: Raw,
    start: Algo,
    pull: Algo,
    cancel: Algo,
    hwm: f64,
    auto_allocate: Option<usize>,
) -> R<V> {
    let c = instance(
        cx,
        js::UNDEFINED,
        Class::ReadableByteStreamController,
        ByteController {
            stream: V::dup(cx, s),
            queue: VecDeque::new(),
            total: 0,
            started: false,
            close_requested: false,
            pull_again: false,
            pulling: false,
            hwm,
            auto_allocate,
            pending: VecDeque::new(),
            byob_request: V::null(),
            pull,
            cancel,
        },
    )?;
    stream(cx, s)?.controller = c.clone_ref();
    let start_result = start.call(cx, &[c.raw()])?;
    let p = js::resolved(cx, start_result.raw())?;
    js::upon(
        cx,
        p.raw(),
        vec![c.clone_ref()],
        |cx, cap, _| {
            bc(cx, cap[0].raw())?.started = true;
            bc_call_pull_if_needed(cx, cap[0].raw())
        },
        |cx, cap, e| bc_error(cx, cap[0].raw(), e),
    )?;
    Ok(c)
}

/// CreateReadableByteStream with native algorithms: the stream and its
/// controller.
pub(crate) fn new_byte_stream(cx: Ctx, pull: Algo, cancel: Algo, hwm: f64) -> R<(V, V)> {
    let s = new_stream(cx, js::UNDEFINED)?;
    let c = setup_byte_controller(cx, s.raw(), Algo::default(), pull, cancel, hwm, None)?;
    Ok((s, c))
}

/// Enqueues `bytes` on byte stream controller `c` (native sources).
pub(crate) fn enqueue_bytes(cx: Ctx, c: Raw, bytes: &[u8]) -> R<()> {
    let view = js::uint8_array(cx, bytes)?;
    bc_enqueue(cx, c, view.raw())
}

/// Closes either controller (native sources), and responds to a pending
/// BYOB read with the end.
pub(crate) fn close_controller(cx: Ctx, c: Raw) -> R<()> {
    if is_byte_controller(cx, c) {
        bc_close(cx, c)?;
        if !bc(cx, c)?.pending.is_empty() {
            bc_respond(cx, c, 0)?;
        }
        Ok(())
    } else {
        dc_close(cx, c)
    }
}

/// Errors either controller.
pub(crate) fn error_controller(cx: Ctx, c: Raw, e: Raw) -> R<()> {
    if is_byte_controller(cx, c) {
        bc_error(cx, c, e)
    } else {
        dc_error(cx, c, e)
    }
}

// --- Readers --------------------------------------------------------------

fn pending_closed(cx: Ctx) -> R<Deferred> {
    Deferred::new(cx)
}

fn rejected_closed(cx: Ctx, e: Raw) -> R<Deferred> {
    let d = Deferred::new(cx)?;
    d.reject(cx, e);
    js::mark_handled(cx, d.promise.raw());
    Ok(d)
}

/// ReadableStreamReaderGenericInitialize's closed promise for `s`.
fn initial_closed(cx: Ctx, s: Raw) -> R<Deferred> {
    let (st, err) = {
        let st = stream(cx, s)?;
        (st.state, st.stored_error.clone_ref())
    };
    match st {
        State::Readable => pending_closed(cx),
        State::Closed => {
            let d = Deferred::new(cx)?;
            d.resolve(cx, js::UNDEFINED);
            Ok(d)
        }
        State::Errored => rejected_closed(cx, err.raw()),
    }
}

/// AcquireReadableStreamDefaultReader (with `new_target` for the
/// constructor).
fn new_default_reader(cx: Ctx, new_target: Raw, s: Raw) -> R<V> {
    if !is_stream(cx, s) {
        return Err(js::type_error(cx, "not a ReadableStream"));
    }
    if is_locked(cx, s)? {
        return Err(js::type_error(cx, "the ReadableStream is locked"));
    }
    let closed = initial_closed(cx, s)?;
    let r = instance(
        cx,
        new_target,
        Class::ReadableStreamDefaultReader,
        DefaultReader {
            common: ReaderCommon {
                stream: V::dup(cx, s),
                closed,
                requests: VecDeque::new(),
            },
        },
    )?;
    stream(cx, s)?.reader = r.clone_ref();
    Ok(r)
}

pub(crate) fn acquire_default_reader(cx: Ctx, s: Raw) -> R<V> {
    new_default_reader(cx, js::UNDEFINED, s)
}

/// AcquireReadableStreamBYOBReader.
fn new_byob_reader(cx: Ctx, new_target: Raw, s: Raw) -> R<V> {
    if !is_stream(cx, s) {
        return Err(js::type_error(cx, "not a ReadableStream"));
    }
    if is_locked(cx, s)? {
        return Err(js::type_error(cx, "the ReadableStream is locked"));
    }
    let controller = controller_of(cx, s)?;
    if !is_byte_controller(cx, controller.raw()) {
        return Err(js::type_error(cx, "a BYOB reader needs a byte stream"));
    }
    let closed = initial_closed(cx, s)?;
    let r = instance(
        cx,
        new_target,
        Class::ReadableStreamBYOBReader,
        ByobReader {
            common: ReaderCommon {
                stream: V::dup(cx, s),
                closed,
                requests: VecDeque::new(),
            },
        },
    )?;
    stream(cx, s)?.reader = r.clone_ref();
    Ok(r)
}

/// ReadableStreamReaderGenericRelease.
fn generic_release(cx: Ctx, reader: Raw) -> R<()> {
    let s = common(cx, reader)?.stream.clone_ref();
    let e = js::type_error_value(cx, "the reader was released");
    let readable = state(cx, s.raw())? == State::Readable;
    if readable {
        let (reject, promise) = {
            let c = common(cx, reader)?;
            (c.closed.reject.clone_ref(), c.closed.promise.clone_ref())
        };
        let _ = js::call(cx, reject.raw(), js::UNDEFINED, &[e.raw()]);
        js::mark_handled(cx, promise.raw());
    } else {
        let d = rejected_closed(cx, e.raw())?;
        let old = std::mem::replace(&mut common(cx, reader)?.closed, d);
        drop(old);
    }
    let controller = controller_of(cx, s.raw())?;
    if is_byte_controller(cx, controller.raw()) {
        bc_release_steps(cx, controller.raw())?;
    }
    let old_reader = stream(cx, s.raw())?.reader.take_out();
    let old_stream = common(cx, reader)?.stream.take_out();
    drop((old_reader, old_stream));
    Ok(())
}

/// ReadableStreamDefaultReaderRelease / BYOBReaderRelease.
pub(crate) fn release_reader(cx: Ctx, reader: Raw) -> R<()> {
    generic_release(cx, reader)?;
    let e = js::type_error_value(cx, "the reader was released");
    let requests = std::mem::take(&mut common(cx, reader)?.requests);
    for r in requests {
        r.error(cx, e.raw());
    }
    Ok(())
}

/// ReadableStreamDefaultReaderRead.
pub(crate) fn default_reader_read(cx: Ctx, reader: Raw, request: ReadRequest) -> R<()> {
    let s = common(cx, reader)?.stream.clone_ref();
    let (st, err, controller) = {
        let mut st = stream(cx, s.raw())?;
        st.disturbed = true;
        (
            st.state,
            st.stored_error.clone_ref(),
            st.controller.clone_ref(),
        )
    };
    match st {
        State::Closed => request.close(cx, js::UNDEFINED),
        State::Errored => request.error(cx, err.raw()),
        State::Readable => {
            if is_byte_controller(cx, controller.raw()) {
                bc_pull_steps(cx, controller.raw(), request)?;
            } else {
                dc_pull_steps(cx, controller.raw(), request)?;
            }
        }
    }
    Ok(())
}

/// ReadableStreamBYOBReaderRead.
fn byob_reader_read(cx: Ctx, reader: Raw, view: Raw, min: usize, request: ReadRequest) -> R<()> {
    let s = common(cx, reader)?.stream.clone_ref();
    let (st, err, controller) = {
        let mut st = stream(cx, s.raw())?;
        st.disturbed = true;
        (
            st.state,
            st.stored_error.clone_ref(),
            st.controller.clone_ref(),
        )
    };
    if st == State::Errored {
        request.error(cx, err.raw());
        return Ok(());
    }
    bc_pull_into(cx, controller.raw(), view, min, request)
}

/// A reader's stream (`None` when released).
pub(crate) fn reader_stream_of(cx: Ctx, reader: Raw) -> R<Option<V>> {
    let s = common(cx, reader)?.stream.clone_ref();
    Ok((!s.is_undefined()).then_some(s))
}

/// The reader's stream (`TypeError` when released).
fn reader_stream(cx: Ctx, reader: Raw) -> R<V> {
    let s = common(cx, reader)?.stream.clone_ref();
    if s.is_undefined() {
        return Err(js::type_error(cx, "the reader was released"));
    }
    Ok(s)
}

native!(
    fn default_reader_constructor(cx, this, args) {
        new_default_reader(cx, this, args.get(0))
    }
);

native!(
    fn byob_reader_constructor(cx, this, args) {
        new_byob_reader(cx, this, args.get(0))
    }
);

native!(
    fn reader_closed(cx, this, args) {
        Ok(common(cx, this)?.closed.promise.clone_ref())
    }
);

native!(
    fn reader_cancel(cx, this, args) {
        js::promise_of(cx, || {
            let s = reader_stream(cx, this)?;
            cancel_stream(cx, s.raw(), args.get(0))
        })
    }
);

native!(
    fn default_reader_read_method(cx, this, args) {
        data::<DefaultReader>(cx, this, "ReadableStreamDefaultReader")?;
        js::promise_of(cx, || {
            reader_stream(cx, this)?;
            let d = Deferred::new(cx)?;
            let promise = d.promise.clone_ref();
            default_reader_read(cx, this, ReadRequest::Promise(d))?;
            Ok(promise)
        })
    }
);

native!(
    fn reader_release_lock(cx, this, args) {
        if common(cx, this)?.stream.is_undefined() {
            return Ok(V::undefined());
        }
        release_reader(cx, this)?;
        Ok(V::undefined())
    }
);

native!(
    fn byob_reader_read_method(cx, this, args) {
        data::<ByobReader>(cx, this, "ReadableStreamBYOBReader")?;
        js::promise_of(cx, || {
            let view = args.get(0);
            let v = js::view(cx, view).ok_or_else(|| js::type_error(cx, "read needs an ArrayBufferView"))?;
            if v.length == 0 {
                return Err(js::type_error(cx, "the view is empty"));
            }
            // SAFETY: reading the buffer's length.
            let buffer_len = unsafe { js::bytes_of(cx, v.buffer.raw()) }.map_or(0, <[u8]>::len);
            if buffer_len == 0 || js::is_detached(cx, v.buffer.raw()) {
                return Err(js::type_error(cx, "the view's buffer is empty or detached"));
            }
            let options = args.get(1);
            let min = if js::is_object(options) {
                let m = js::get(cx, options, "min")?;
                if m.is_undefined() { 1 } else { js::to_index(cx, m.raw())? as usize }
            } else {
                1
            };
            if min == 0 {
                return Err(js::type_error(cx, "min must be greater than 0"));
            }
            let limit = if v.kind.is_some() { v.length / v.element.max(1) } else { v.length };
            if min > limit {
                return Err(js::range_error(cx, "min is larger than the view"));
            }
            reader_stream(cx, this)?;
            let d = Deferred::new(cx)?;
            let promise = d.promise.clone_ref();
            byob_reader_read(cx, this, view, min, ReadRequest::Promise(d))?;
            Ok(promise)
        })
    }
);

// --- Controllers' methods -------------------------------------------------

native!(
    fn dc_desired_size_get(cx, this, args) {
        Ok(match dc_desired_size(cx, this)? {
            Some(n) => V::num(n),
            None => V::null(),
        })
    }
);

native!(
    fn dc_close_method(cx, this, args) {
        if !dc_can_close_or_enqueue(cx, this)? {
            return Err(js::type_error(cx, "the stream cannot be closed"));
        }
        dc_close(cx, this)?;
        Ok(V::undefined())
    }
);

native!(
    fn dc_enqueue_method(cx, this, args) {
        if !dc_can_close_or_enqueue(cx, this)? {
            return Err(js::type_error(cx, "the stream cannot be enqueued to"));
        }
        dc_enqueue(cx, this, args.get(0))?;
        Ok(V::undefined())
    }
);

native!(
    fn dc_error_method(cx, this, args) {
        dc(cx, this)?;
        dc_error(cx, this, args.get(0))?;
        Ok(V::undefined())
    }
);

native!(
    fn bc_byob_request_get(cx, this, args) {
        bc_byob_request(cx, this)
    }
);

native!(
    fn bc_desired_size_get(cx, this, args) {
        Ok(match bc_desired_size(cx, this)? {
            Some(n) => V::num(n),
            None => V::null(),
        })
    }
);

native!(
    fn bc_close_method(cx, this, args) {
        let s = bc_stream(cx, this)?;
        if bc(cx, this)?.close_requested {
            return Err(js::type_error(cx, "the stream is already closing"));
        }
        if state(cx, s.raw())? != State::Readable {
            return Err(js::type_error(cx, "the stream is not readable"));
        }
        bc_close(cx, this)?;
        Ok(V::undefined())
    }
);

native!(
    fn bc_enqueue_method(cx, this, args) {
        let chunk = args.get(0);
        let v = js::view(cx, chunk).ok_or_else(|| js::type_error(cx, "chunk must be an ArrayBufferView"))?;
        if v.length == 0 {
            return Err(js::type_error(cx, "the chunk is empty"));
        }
        // SAFETY: reading the buffer's length.
        if unsafe { js::bytes_of(cx, v.buffer.raw()) }.map_or(0, <[u8]>::len) == 0 {
            return Err(js::type_error(cx, "the chunk's buffer is empty"));
        }
        let s = bc_stream(cx, this)?;
        if bc(cx, this)?.close_requested {
            return Err(js::type_error(cx, "the stream is closing"));
        }
        if state(cx, s.raw())? != State::Readable {
            return Err(js::type_error(cx, "the stream is not readable"));
        }
        bc_enqueue(cx, this, chunk)?;
        Ok(V::undefined())
    }
);

native!(
    fn bc_error_method(cx, this, args) {
        bc(cx, this)?;
        bc_error(cx, this, args.get(0))?;
        Ok(V::undefined())
    }
);

fn byob_request<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, ByobRequest>> {
    data::<ByobRequest>(cx, v, "ReadableStreamBYOBRequest")
}

native!(
    fn byob_request_view(cx, this, args) {
        Ok(byob_request(cx, this)?.view.clone_ref())
    }
);

native!(
    fn byob_request_respond(cx, this, args) {
        let written = js::to_index(cx, args.get(0))? as usize;
        let (controller, view) = {
            let r = byob_request(cx, this)?;
            (r.controller.clone_ref(), r.view.clone_ref())
        };
        if controller.is_undefined() {
            return Err(js::type_error(cx, "the request was already answered"));
        }
        if let Some(v) = js::view(cx, view.raw())
            && js::is_detached(cx, v.buffer.raw())
        {
            return Err(js::type_error(cx, "the view's buffer is detached"));
        }
        bc_respond(cx, controller.raw(), written)?;
        Ok(V::undefined())
    }
);

native!(
    fn byob_request_respond_with_new_view(cx, this, args) {
        let controller = byob_request(cx, this)?.controller.clone_ref();
        if controller.is_undefined() {
            return Err(js::type_error(cx, "the request was already answered"));
        }
        bc_respond_with_new_view(cx, controller.raw(), args.get(0))?;
        Ok(V::undefined())
    }
);

// --- ReadableStream -------------------------------------------------------

native!(
    fn stream_constructor(cx, this, args) {
        let source = args.get(0);
        if !js::is_nullish(source) && !js::is_object(source) {
            return Err(js::type_error(cx, "the underlying source must be an object"));
        }
        let strategy = QueuingStrategy::read(cx, args.get(1))?;
        let source_v = V::dup(cx, source);
        let auto = if js::is_object(source) {
            let a = js::get(cx, source, "autoAllocateChunkSize")?;
            if a.is_undefined() { None } else { Some(js::to_index(cx, a.raw())? as usize) }
        } else {
            None
        };
        let cancel = method(cx, source, "cancel")?;
        let pull = method(cx, source, "pull")?;
        let start = method(cx, source, "start")?;
        let kind = if js::is_object(source) {
            let t = js::get(cx, source, "type")?;
            js::opt_string(cx, t.raw())?
        } else {
            None
        };
        let s = new_stream(cx, this)?;
        match kind.as_deref() {
            Some("bytes") => {
                if !strategy.size.is_undefined() {
                    return Err(js::range_error(cx, "a byte stream has no size algorithm"));
                }
                let hwm = strategy.high_water_mark(cx, 0.0)?;
                if auto == Some(0) {
                    return Err(js::type_error(cx, "autoAllocateChunkSize must be greater than 0"));
                }
                setup_byte_controller(
                    cx,
                    s.raw(),
                    Algo::method(start, &source_v),
                    Algo::method(pull, &source_v),
                    Algo::method(cancel, &source_v),
                    hwm,
                    auto,
                )?;
            }
            None => {
                let hwm = strategy.high_water_mark(cx, 1.0)?;
                setup_default_controller(
                    cx,
                    s.raw(),
                    Algo::method(start, &source_v),
                    Algo::method(pull, &source_v),
                    Algo::method(cancel, &source_v),
                    hwm,
                    strategy.size,
                )?;
            }
            Some(other) => {
                return Err(js::type_error(cx, &format!("invalid stream type `{other}`")));
            }
        }
        Ok(s)
    }
);

native!(
    fn stream_locked(cx, this, args) {
        Ok(V::bool(is_locked(cx, this)?))
    }
);

native!(
    fn stream_cancel(cx, this, args) {
        js::promise_of(cx, || {
            if is_locked(cx, this)? {
                return Err(js::type_error(cx, "the ReadableStream is locked"));
            }
            cancel_stream(cx, this, args.get(0))
        })
    }
);

native!(
    fn stream_get_reader(cx, this, args) {
        stream(cx, this)?;
        let options = args.get(0);
        let mode = if js::is_object(options) {
            let m = js::get(cx, options, "mode")?;
            js::opt_string(cx, m.raw())?
        } else if js::is_nullish(options) {
            None
        } else {
            return Err(js::type_error(cx, "getReader options must be an object"));
        };
        match mode.as_deref() {
            None => acquire_default_reader(cx, this),
            Some("byob") => new_byob_reader(cx, js::UNDEFINED, this),
            Some(other) => Err(js::type_error(cx, &format!("invalid reader mode `{other}`"))),
        }
    }
);

/// The options of `pipeTo` / `pipeThrough`.
fn pipe_options(cx: Ctx, options: Raw) -> R<(bool, bool, bool, Option<V>)> {
    if js::is_nullish(options) {
        return Ok((false, false, false, None));
    }
    if !js::is_object(options) {
        return Err(js::type_error(cx, "pipe options must be an object"));
    }
    let flag = |name| js::get(cx, options, name).map(|v| js::to_bool(cx, v.raw()));
    let (prevent_abort, prevent_cancel, prevent_close) = (
        flag("preventAbort")?,
        flag("preventCancel")?,
        flag("preventClose")?,
    );
    let signal = js::get(cx, options, "signal")?;
    let signal = if signal.is_undefined() {
        None
    } else if crate::web::event::is_signal(cx, signal.raw()) {
        Some(signal)
    } else {
        return Err(js::type_error(cx, "signal is not an AbortSignal"));
    };
    Ok((prevent_close, prevent_abort, prevent_cancel, signal))
}

native!(
    fn stream_pipe_through(cx, this, args) {
        stream(cx, this)?;
        let transform = args.get(0);
        if !js::is_object(transform) {
            return Err(js::type_error(cx, "pipeThrough needs { writable, readable }"));
        }
        let readable = js::get(cx, transform, "readable")?;
        if !is_stream(cx, readable.raw()) {
            return Err(js::type_error(cx, "readable is not a ReadableStream"));
        }
        let writable = js::get(cx, transform, "writable")?;
        if !writable::is_stream(cx, writable.raw()) {
            return Err(js::type_error(cx, "writable is not a WritableStream"));
        }
        let (prevent_close, prevent_abort, prevent_cancel, signal) = pipe_options(cx, args.get(1))?;
        if is_locked(cx, this)? {
            return Err(js::type_error(cx, "the ReadableStream is locked"));
        }
        if writable::is_locked(cx, writable.raw())? {
            return Err(js::type_error(cx, "the WritableStream is locked"));
        }
        let p = pipe_to(cx, this, writable.raw(), prevent_close, prevent_abort, prevent_cancel, signal)?;
        js::mark_handled(cx, p.raw());
        Ok(readable)
    }
);

native!(
    fn stream_pipe_to(cx, this, args) {
        js::promise_of(cx, || {
            stream(cx, this)?;
            let dest = args.get(0);
            if !writable::is_stream(cx, dest) {
                return Err(js::type_error(cx, "pipeTo needs a WritableStream"));
            }
            let (prevent_close, prevent_abort, prevent_cancel, signal) = pipe_options(cx, args.get(1))?;
            if is_locked(cx, this)? {
                return Err(js::type_error(cx, "the ReadableStream is locked"));
            }
            if writable::is_locked(cx, dest)? {
                return Err(js::type_error(cx, "the WritableStream is locked"));
            }
            pipe_to(cx, this, dest, prevent_close, prevent_abort, prevent_cancel, signal)
        })
    }
);

native!(
    fn stream_tee(cx, this, args) {
        stream(cx, this)?;
        let controller = controller_of(cx, this)?;
        let (a, b) = if is_byte_controller(cx, controller.raw()) {
            byte_tee(cx, this)?
        } else {
            default_tee(cx, this)?
        };
        js::new_array(cx, vec![a, b])
    }
);

/// ReadableStreamTee for callers (`Response.clone()`, ...).
pub(crate) fn tee(cx: Ctx, s: Raw) -> R<(V, V)> {
    let controller = controller_of(cx, s)?;
    if is_byte_controller(cx, controller.raw()) {
        byte_tee(cx, s)
    } else {
        default_tee(cx, s)
    }
}

// --- Internal state objects -----------------------------------------------

/// The state of a tee, a pipe or an async iterator, shared by closures.
pub(crate) struct Internal<T: js::Trace + 'static>(pub(crate) T);

impl<T: js::Trace + 'static> js::Trace for Internal<T> {
    fn trace(&self, mark: &mut dyn FnMut(Raw)) {
        self.0.trace(mark);
    }
}

impl<T: js::Trace + 'static> Object for Internal<T> {}

pub(crate) fn new_internal<T: js::Trace + 'static>(cx: Ctx, state: T) -> R<V> {
    instance(cx, js::UNDEFINED, Class::Internal, Internal(state))
}

pub(crate) fn internal<'a, T: js::Trace + 'static>(cx: Ctx, v: Raw) -> R<RefMut<'a, T>> {
    Ok(RefMut::map(
        data::<Internal<T>>(cx, v, "internal state")?,
        |i| &mut i.0,
    ))
}

/// `queueMicrotask(f)`.
fn microtask(cx: Ctx, f: V) -> R<()> {
    let g = js::global(cx);
    let q = js::get(cx, g.raw(), "queueMicrotask")?;
    js::call(cx, q.raw(), js::UNDEFINED, &[f.raw()])?;
    Ok(())
}

// --- Tee ------------------------------------------------------------------

struct Tee {
    stream: V,
    reader: V,
    reading: bool,
    read_again: bool,
    read_again_1: bool,
    read_again_2: bool,
    canceled_1: bool,
    canceled_2: bool,
    reason_1: V,
    reason_2: V,
    branch_1: V,
    branch_2: V,
    cancel: Deferred,
}

trace!(Tee {
    stream,
    reader,
    reason_1,
    reason_2,
    branch_1,
    branch_2,
    cancel
});

fn tee_state<'a>(cx: Ctx, t: Raw) -> R<RefMut<'a, Tee>> {
    internal::<Tee>(cx, t)
}

fn new_tee(cx: Ctx, s: Raw, reader: V) -> R<V> {
    let cancel = Deferred::new(cx)?;
    new_internal(
        cx,
        Tee {
            stream: V::dup(cx, s),
            reader,
            reading: false,
            read_again: false,
            read_again_1: false,
            read_again_2: false,
            canceled_1: false,
            canceled_2: false,
            reason_1: V::undefined(),
            reason_2: V::undefined(),
            branch_1: V::undefined(),
            branch_2: V::undefined(),
            cancel,
        },
    )
}

/// A branch's cancel algorithm (`second`: of branch 2).
fn tee_cancel(cx: Ctx, t: &V, second: bool) -> R<V> {
    js::closure(cx, vec![t.clone_ref()], move |cx, c, args| {
        let t = c[0].raw();
        let (both, s, promise) = {
            let mut st = tee_state(cx, t)?;
            if second {
                st.canceled_2 = true;
                st.reason_2 = V::dup(cx, args.get(0));
            } else {
                st.canceled_1 = true;
                st.reason_1 = V::dup(cx, args.get(0));
            }
            let both = st.canceled_1 && st.canceled_2;
            let reasons = both.then(|| (st.reason_1.clone_ref(), st.reason_2.clone_ref()));
            (
                reasons,
                st.stream.clone_ref(),
                st.cancel.promise.clone_ref(),
            )
        };
        if let Some((r1, r2)) = both {
            let composite = js::new_array(cx, vec![r1, r2])?;
            let result = cancel_stream(cx, s.raw(), composite.raw())?;
            let resolve = tee_state(cx, t)?.cancel.resolve.clone_ref();
            js::call(cx, resolve.raw(), js::UNDEFINED, &[result.raw()])?;
        }
        Ok(promise)
    })
}

fn tee_resolve_cancel_if_needed(cx: Ctx, t: Raw) -> R<()> {
    let (needed, resolve) = {
        let st = tee_state(cx, t)?;
        (
            !st.canceled_1 || !st.canceled_2,
            st.cancel.resolve.clone_ref(),
        )
    };
    if needed {
        js::call(cx, resolve.raw(), js::UNDEFINED, &[js::UNDEFINED])?;
    }
    Ok(())
}

/// ReadableStreamDefaultTee (without cloning).
fn default_tee(cx: Ctx, s: Raw) -> R<(V, V)> {
    let reader = acquire_default_reader(cx, s)?;
    let t = new_tee(cx, s, reader.clone_ref())?;
    let pull = js::closure(cx, vec![t.clone_ref()], |cx, c, _| {
        default_tee_pull(cx, c[0].raw())?;
        js::resolved(cx, js::UNDEFINED)
    })?;
    let pull = Algo::native(pull);
    let (b1, _) = new_default_stream(
        cx,
        Algo::default(),
        pull.clone_ref(),
        Algo::native(tee_cancel(cx, &t, false)?),
        1.0,
        V::undefined(),
    )?;
    let (b2, _) = new_default_stream(
        cx,
        Algo::default(),
        pull,
        Algo::native(tee_cancel(cx, &t, true)?),
        1.0,
        V::undefined(),
    )?;
    {
        let mut st = tee_state(cx, t.raw())?;
        st.branch_1 = b1.clone_ref();
        st.branch_2 = b2.clone_ref();
    }
    let closed = common(cx, reader.raw())?.closed.promise.clone_ref();
    js::upon(
        cx,
        closed.raw(),
        vec![t.clone_ref()],
        |_, _, _| Ok(()),
        |cx, c, e| {
            let (b1, b2) = {
                let st = tee_state(cx, c[0].raw())?;
                (st.branch_1.clone_ref(), st.branch_2.clone_ref())
            };
            dc_error(cx, controller_of(cx, b1.raw())?.raw(), e)?;
            dc_error(cx, controller_of(cx, b2.raw())?.raw(), e)?;
            tee_resolve_cancel_if_needed(cx, c[0].raw())
        },
    )?;
    Ok((b1, b2))
}

fn default_tee_pull(cx: Ctx, t: Raw) -> R<()> {
    let reader = {
        let mut st = tee_state(cx, t)?;
        if st.reading {
            st.read_again = true;
            return Ok(());
        }
        st.reading = true;
        st.reader.clone_ref()
    };
    let request = ReadRequest::steps(
        cx,
        vec![V::dup(cx, t)],
        |cx, c, chunk| {
            let task = js::closure(cx, vec![c[0].clone_ref(), V::dup(cx, chunk)], |cx, c, _| {
                let t = c[0].raw();
                let (b1, b2, canceled_1, canceled_2) = {
                    let mut st = tee_state(cx, t)?;
                    st.read_again = false;
                    (
                        st.branch_1.clone_ref(),
                        st.branch_2.clone_ref(),
                        st.canceled_1,
                        st.canceled_2,
                    )
                };
                if !canceled_1 {
                    dc_enqueue(cx, controller_of(cx, b1.raw())?.raw(), c[1].raw())?;
                }
                if !canceled_2 {
                    dc_enqueue(cx, controller_of(cx, b2.raw())?.raw(), c[1].raw())?;
                }
                let again = {
                    let mut st = tee_state(cx, t)?;
                    st.reading = false;
                    st.read_again
                };
                if again {
                    default_tee_pull(cx, t)?;
                }
                Ok(V::undefined())
            })?;
            microtask(cx, task)
        },
        |cx, c, _| {
            let t = c[0].raw();
            let (b1, b2, canceled_1, canceled_2) = {
                let mut st = tee_state(cx, t)?;
                st.reading = false;
                (
                    st.branch_1.clone_ref(),
                    st.branch_2.clone_ref(),
                    st.canceled_1,
                    st.canceled_2,
                )
            };
            if !canceled_1 {
                dc_close(cx, controller_of(cx, b1.raw())?.raw())?;
            }
            if !canceled_2 {
                dc_close(cx, controller_of(cx, b2.raw())?.raw())?;
            }
            tee_resolve_cancel_if_needed(cx, t)
        },
        |cx, c, _| {
            tee_state(cx, c[0].raw())?.reading = false;
            Ok(())
        },
    )?;
    default_reader_read(cx, reader.raw(), request)
}

/// ReadableByteStreamTee.
fn byte_tee(cx: Ctx, s: Raw) -> R<(V, V)> {
    let reader = acquire_default_reader(cx, s)?;
    let t = new_tee(cx, s, reader.clone_ref())?;
    let pull = |second: bool| {
        js::closure(cx, vec![t.clone_ref()], move |cx, c, _| {
            byte_tee_pull(cx, c[0].raw(), second)?;
            js::resolved(cx, js::UNDEFINED)
        })
    };
    let (b1, _) = new_byte_stream(
        cx,
        Algo::native(pull(false)?),
        Algo::native(tee_cancel(cx, &t, false)?),
        0.0,
    )?;
    let (b2, _) = new_byte_stream(
        cx,
        Algo::native(pull(true)?),
        Algo::native(tee_cancel(cx, &t, true)?),
        0.0,
    )?;
    {
        let mut st = tee_state(cx, t.raw())?;
        st.branch_1 = b1.clone_ref();
        st.branch_2 = b2.clone_ref();
    }
    forward_reader_error(cx, t.raw(), reader.raw())?;
    Ok((b1, b2))
}

fn forward_reader_error(cx: Ctx, t: Raw, reader: Raw) -> R<()> {
    let closed = common(cx, reader)?.closed.promise.clone_ref();
    js::upon(
        cx,
        closed.raw(),
        vec![V::dup(cx, t), V::dup(cx, reader)],
        |_, _, _| Ok(()),
        |cx, c, e| {
            let (current, b1, b2) = {
                let st = tee_state(cx, c[0].raw())?;
                (
                    st.reader.clone_ref(),
                    st.branch_1.clone_ref(),
                    st.branch_2.clone_ref(),
                )
            };
            if !js::same(current.raw(), c[1].raw()) {
                return Ok(());
            }
            bc_error(cx, controller_of(cx, b1.raw())?.raw(), e)?;
            bc_error(cx, controller_of(cx, b2.raw())?.raw(), e)?;
            tee_resolve_cancel_if_needed(cx, c[0].raw())
        },
    )
}

fn byte_tee_pull(cx: Ctx, t: Raw, second: bool) -> R<()> {
    let branch = {
        let mut st = tee_state(cx, t)?;
        if st.reading {
            if second {
                st.read_again_2 = true;
            } else {
                st.read_again_1 = true;
            }
            return Ok(());
        }
        st.reading = true;
        if second {
            st.branch_2.clone_ref()
        } else {
            st.branch_1.clone_ref()
        }
    };
    let controller = controller_of(cx, branch.raw())?;
    let request = bc_byob_request(cx, controller.raw())?;
    if request.is_nullish() {
        byte_tee_pull_default(cx, t)
    } else {
        let view = byob_request(cx, request.raw())?.view.clone_ref();
        byte_tee_pull_byob(cx, t, view.raw(), second)
    }
}

/// After a chunk: the pulls asked for meanwhile.
fn byte_tee_again(cx: Ctx, t: Raw) -> R<()> {
    let (a1, a2) = {
        let mut st = tee_state(cx, t)?;
        st.reading = false;
        (st.read_again_1, st.read_again_2)
    };
    if a1 {
        byte_tee_pull(cx, t, false)
    } else if a2 {
        byte_tee_pull(cx, t, true)
    } else {
        Ok(())
    }
}

fn byte_tee_error_both(cx: Ctx, t: Raw, e: Raw) -> R<()> {
    let (b1, b2, s, resolve) = {
        let st = tee_state(cx, t)?;
        (
            st.branch_1.clone_ref(),
            st.branch_2.clone_ref(),
            st.stream.clone_ref(),
            st.cancel.resolve.clone_ref(),
        )
    };
    bc_error(cx, controller_of(cx, b1.raw())?.raw(), e)?;
    bc_error(cx, controller_of(cx, b2.raw())?.raw(), e)?;
    let result = cancel_stream(cx, s.raw(), e)?;
    js::call(cx, resolve.raw(), js::UNDEFINED, &[result.raw()])?;
    Ok(())
}

/// A copy of `chunk` (an ArrayBufferView) as a Uint8Array.
fn clone_as_uint8(cx: Ctx, chunk: Raw) -> R<V> {
    let bytes =
        js::buffer_source(cx, chunk).ok_or_else(|| js::type_error(cx, "not an ArrayBufferView"))?;
    js::uint8_array(cx, &bytes)
}

fn byte_tee_pull_default(cx: Ctx, t: Raw) -> R<()> {
    let (reader, s) = {
        let st = tee_state(cx, t)?;
        (st.reader.clone_ref(), st.stream.clone_ref())
    };
    let reader = if is::<ByobReader>(cx, reader.raw()) {
        release_reader(cx, reader.raw())?;
        let r = acquire_default_reader(cx, s.raw())?;
        tee_state(cx, t)?.reader = r.clone_ref();
        forward_reader_error(cx, t, r.raw())?;
        r
    } else {
        reader
    };
    let request = ReadRequest::steps(
        cx,
        vec![V::dup(cx, t)],
        |cx, c, chunk| {
            let task = js::closure(cx, vec![c[0].clone_ref(), V::dup(cx, chunk)], |cx, c, _| {
                let t = c[0].raw();
                let (b1, b2, canceled_1, canceled_2) = {
                    let mut st = tee_state(cx, t)?;
                    st.read_again_1 = false;
                    st.read_again_2 = false;
                    (
                        st.branch_1.clone_ref(),
                        st.branch_2.clone_ref(),
                        st.canceled_1,
                        st.canceled_2,
                    )
                };
                let chunk_1 = c[1].clone_ref();
                let mut chunk_2 = c[1].clone_ref();
                if !canceled_1 && !canceled_2 {
                    match clone_as_uint8(cx, c[1].raw()) {
                        Ok(clone) => chunk_2 = clone,
                        Err(_) => {
                            let e = js::take_exception(cx);
                            byte_tee_error_both(cx, t, e.raw())?;
                            return Ok(V::undefined());
                        }
                    }
                }
                if !canceled_1 {
                    bc_enqueue(cx, controller_of(cx, b1.raw())?.raw(), chunk_1.raw())?;
                }
                if !canceled_2 {
                    bc_enqueue(cx, controller_of(cx, b2.raw())?.raw(), chunk_2.raw())?;
                }
                byte_tee_again(cx, t)?;
                Ok(V::undefined())
            })?;
            microtask(cx, task)
        },
        |cx, c, _| {
            let t = c[0].raw();
            let (b1, b2, canceled_1, canceled_2) = {
                let mut st = tee_state(cx, t)?;
                st.reading = false;
                (
                    st.branch_1.clone_ref(),
                    st.branch_2.clone_ref(),
                    st.canceled_1,
                    st.canceled_2,
                )
            };
            let (c1, c2) = (controller_of(cx, b1.raw())?, controller_of(cx, b2.raw())?);
            if !canceled_1 {
                bc_close(cx, c1.raw())?;
            }
            if !canceled_2 {
                bc_close(cx, c2.raw())?;
            }
            if !bc(cx, c1.raw())?.pending.is_empty() {
                bc_respond(cx, c1.raw(), 0)?;
            }
            if !bc(cx, c2.raw())?.pending.is_empty() {
                bc_respond(cx, c2.raw(), 0)?;
            }
            tee_resolve_cancel_if_needed(cx, t)
        },
        |cx, c, _| {
            tee_state(cx, c[0].raw())?.reading = false;
            Ok(())
        },
    )?;
    default_reader_read(cx, reader.raw(), request)
}

fn byte_tee_pull_byob(cx: Ctx, t: Raw, view: Raw, second: bool) -> R<()> {
    let (reader, s) = {
        let st = tee_state(cx, t)?;
        (st.reader.clone_ref(), st.stream.clone_ref())
    };
    let reader = if is::<DefaultReader>(cx, reader.raw()) {
        release_reader(cx, reader.raw())?;
        let r = new_byob_reader(cx, js::UNDEFINED, s.raw())?;
        tee_state(cx, t)?.reader = r.clone_ref();
        forward_reader_error(cx, t, r.raw())?;
        r
    } else {
        reader
    };
    // Which branch reads with its own buffer, and the other.
    let branches = move |cx: Ctx, t: Raw| -> R<(V, V, bool, bool)> {
        let st = tee_state(cx, t)?;
        Ok(if second {
            (
                st.branch_2.clone_ref(),
                st.branch_1.clone_ref(),
                st.canceled_2,
                st.canceled_1,
            )
        } else {
            (
                st.branch_1.clone_ref(),
                st.branch_2.clone_ref(),
                st.canceled_1,
                st.canceled_2,
            )
        })
    };
    let request = ReadRequest::steps(
        cx,
        vec![V::dup(cx, t)],
        move |cx, c, chunk| {
            let task = js::closure(
                cx,
                vec![c[0].clone_ref(), V::dup(cx, chunk)],
                move |cx, c, _| {
                    let t = c[0].raw();
                    {
                        let mut st = tee_state(cx, t)?;
                        st.read_again_1 = false;
                        st.read_again_2 = false;
                    }
                    let (byob, other, byob_canceled, other_canceled) = branches(cx, t)?;
                    let byob_c = controller_of(cx, byob.raw())?;
                    if !other_canceled {
                        let clone = match clone_as_uint8(cx, c[1].raw()) {
                            Ok(clone) => clone,
                            Err(_) => {
                                let e = js::take_exception(cx);
                                byte_tee_error_both(cx, t, e.raw())?;
                                return Ok(V::undefined());
                            }
                        };
                        if !byob_canceled {
                            bc_respond_with_new_view(cx, byob_c.raw(), c[1].raw())?;
                        }
                        bc_enqueue(cx, controller_of(cx, other.raw())?.raw(), clone.raw())?;
                    } else if !byob_canceled {
                        bc_respond_with_new_view(cx, byob_c.raw(), c[1].raw())?;
                    }
                    byte_tee_again(cx, t)?;
                    Ok(V::undefined())
                },
            )?;
            microtask(cx, task)
        },
        move |cx, c, chunk| {
            let t = c[0].raw();
            tee_state(cx, t)?.reading = false;
            let (byob, other, byob_canceled, other_canceled) = branches(cx, t)?;
            let (byob_c, other_c) = (
                controller_of(cx, byob.raw())?,
                controller_of(cx, other.raw())?,
            );
            if !byob_canceled {
                bc_close(cx, byob_c.raw())?;
            }
            if !other_canceled {
                bc_close(cx, other_c.raw())?;
            }
            if !js::is_undefined(chunk) {
                if !byob_canceled {
                    bc_respond_with_new_view(cx, byob_c.raw(), chunk)?;
                }
                if !other_canceled && !bc(cx, other_c.raw())?.pending.is_empty() {
                    bc_respond(cx, other_c.raw(), 0)?;
                }
            }
            if !byob_canceled || !other_canceled {
                let resolve = tee_state(cx, t)?.cancel.resolve.clone_ref();
                js::call(cx, resolve.raw(), js::UNDEFINED, &[js::UNDEFINED])?;
            }
            Ok(())
        },
        |cx, c, _| {
            tee_state(cx, c[0].raw())?.reading = false;
            Ok(())
        },
    )?;
    byob_reader_read(cx, reader.raw(), view, 1, request)
}

// --- pipeTo ---------------------------------------------------------------

struct Pipe {
    source: V,
    dest: V,
    reader: V,
    writer: V,
    prevent_close: bool,
    prevent_abort: bool,
    prevent_cancel: bool,
    signal: V,
    abort_algorithm: u32,
    shutting_down: bool,
    current_write: V,
    promise: Deferred,
}

trace!(Pipe {
    source,
    dest,
    reader,
    writer,
    signal,
    current_write,
    promise
});

fn pipe<'a>(cx: Ctx, p: Raw) -> R<RefMut<'a, Pipe>> {
    internal::<Pipe>(cx, p)
}

/// ReadableStreamPipeTo.
pub(crate) fn pipe_to(
    cx: Ctx,
    source: Raw,
    dest: Raw,
    prevent_close: bool,
    prevent_abort: bool,
    prevent_cancel: bool,
    signal: Option<V>,
) -> R<V> {
    let reader = acquire_default_reader(cx, source)?;
    let writer = writable::acquire_writer(cx, dest)?;
    stream(cx, source)?.disturbed = true;
    let promise = Deferred::new(cx)?;
    let result = promise.promise.clone_ref();
    let p = new_internal(
        cx,
        Pipe {
            source: V::dup(cx, source),
            dest: V::dup(cx, dest),
            reader: reader.clone_ref(),
            writer: writer.clone_ref(),
            prevent_close,
            prevent_abort,
            prevent_cancel,
            signal: signal.as_ref().map_or_else(V::undefined, V::clone_ref),
            abort_algorithm: 0,
            shutting_down: false,
            current_write: js::resolved(cx, js::UNDEFINED)?,
            promise,
        },
    )?;
    if let Some(signal) = &signal {
        let abort = js::closure(cx, vec![p.clone_ref()], |cx, c, _| {
            pipe_abort(cx, c[0].raw())?;
            Ok(V::undefined())
        })?;
        if crate::web::event::aborted(cx, signal.raw())? {
            pipe_abort(cx, p.raw())?;
            return Ok(result);
        }
        let id = crate::web::event::add_algorithm(cx, signal.raw(), abort)?;
        pipe(cx, p.raw())?.abort_algorithm = id;
    }
    // Errors and closings are propagated as they are or become.
    let reader_closed = common(cx, reader.raw())?.closed.promise.clone_ref();
    js::upon(
        cx,
        reader_closed.raw(),
        vec![p.clone_ref()],
        |cx, c, _| pipe_source_closed(cx, c[0].raw()),
        |cx, c, e| pipe_source_errored(cx, c[0].raw(), e),
    )?;
    let writer_closed = writable::writer_closed(cx, writer.raw())?;
    js::upon(
        cx,
        writer_closed.raw(),
        vec![p.clone_ref()],
        |_, _, _| Ok(()),
        |cx, c, e| pipe_dest_errored(cx, c[0].raw(), e),
    )?;
    // The current states.
    let source_state = state(cx, source)?;
    let dest_state = writable::state_of(cx, dest)?;
    if source_state == State::Errored {
        let e = stored_error(cx, source)?;
        pipe_source_errored(cx, p.raw(), e.raw())?;
    } else if dest_state == WState::Errored {
        let e = writable::stored_error(cx, dest)?;
        pipe_dest_errored(cx, p.raw(), e.raw())?;
    } else if source_state == State::Closed {
        pipe_source_closed(cx, p.raw())?;
    }
    if writable::close_queued_or_in_flight(cx, dest)?
        || writable::state_of(cx, dest)? == WState::Closed
    {
        pipe_dest_closed(cx, p.raw())?;
    }
    pipe_loop(cx, p.raw())?;
    Ok(result)
}

/// One step of the loop: when the destination is ready, a read, and the
/// write of what it reads.
fn pipe_loop(cx: Ctx, p: Raw) -> R<()> {
    let writer = {
        let st = pipe(cx, p)?;
        if st.shutting_down {
            return Ok(());
        }
        st.writer.clone_ref()
    };
    let ready = writable::writer_ready(cx, writer.raw())?;
    js::upon(
        cx,
        ready.raw(),
        vec![V::dup(cx, p)],
        |cx, c, _| {
            let p = c[0].raw();
            let reader = {
                let st = pipe(cx, p)?;
                if st.shutting_down {
                    return Ok(());
                }
                st.reader.clone_ref()
            };
            let request = ReadRequest::steps(
                cx,
                vec![V::dup(cx, p)],
                |cx, c, chunk| {
                    let p = c[0].raw();
                    let writer = pipe(cx, p)?.writer.clone_ref();
                    let w = writable::writer_write(cx, writer.raw(), chunk)?;
                    js::mark_handled(cx, w.raw());
                    pipe(cx, p)?.current_write = w;
                    pipe_loop(cx, p)
                },
                |_, _, _| Ok(()),
                |_, _, _| Ok(()),
            )?;
            default_reader_read(cx, reader.raw(), request)
        },
        |_, _, _| Ok(()),
    )
}

fn pipe_source_errored(cx: Ctx, p: Raw, e: Raw) -> R<()> {
    let (prevent_abort, dest) = {
        let st = pipe(cx, p)?;
        (st.prevent_abort, st.dest.clone_ref())
    };
    if prevent_abort {
        pipe_shutdown(cx, p, Some(V::dup(cx, e)))
    } else {
        let action = js::closure(cx, vec![dest, V::dup(cx, e)], |cx, c, _| {
            writable::abort_stream(cx, c[0].raw(), c[1].raw())
        })?;
        pipe_shutdown_with_action(cx, p, action, Some(V::dup(cx, e)))
    }
}

fn pipe_dest_errored(cx: Ctx, p: Raw, e: Raw) -> R<()> {
    let (prevent_cancel, source) = {
        let st = pipe(cx, p)?;
        (st.prevent_cancel, st.source.clone_ref())
    };
    if prevent_cancel {
        pipe_shutdown(cx, p, Some(V::dup(cx, e)))
    } else {
        let action = js::closure(cx, vec![source, V::dup(cx, e)], |cx, c, _| {
            cancel_stream(cx, c[0].raw(), c[1].raw())
        })?;
        pipe_shutdown_with_action(cx, p, action, Some(V::dup(cx, e)))
    }
}

fn pipe_source_closed(cx: Ctx, p: Raw) -> R<()> {
    let (prevent_close, writer) = {
        let st = pipe(cx, p)?;
        (st.prevent_close, st.writer.clone_ref())
    };
    if prevent_close {
        pipe_shutdown(cx, p, None)
    } else {
        let action = js::closure(cx, vec![writer], |cx, c, _| {
            writable::writer_close_with_error_propagation(cx, c[0].raw())
        })?;
        pipe_shutdown_with_action(cx, p, action, None)
    }
}

fn pipe_dest_closed(cx: Ctx, p: Raw) -> R<()> {
    let e = js::type_error_value(cx, "the destination is closed");
    let (prevent_cancel, source) = {
        let st = pipe(cx, p)?;
        (st.prevent_cancel, st.source.clone_ref())
    };
    if prevent_cancel {
        pipe_shutdown(cx, p, Some(e))
    } else {
        let action = js::closure(cx, vec![source, e.clone_ref()], |cx, c, _| {
            cancel_stream(cx, c[0].raw(), c[1].raw())
        })?;
        pipe_shutdown_with_action(cx, p, action, Some(e))
    }
}

/// The signal aborted the pipe.
fn pipe_abort(cx: Ctx, p: Raw) -> R<()> {
    let (signal, prevent_abort, prevent_cancel, source, dest) = {
        let st = pipe(cx, p)?;
        (
            st.signal.clone_ref(),
            st.prevent_abort,
            st.prevent_cancel,
            st.source.clone_ref(),
            st.dest.clone_ref(),
        )
    };
    let error = crate::web::event::reason(cx, signal.raw())?;
    let action = js::closure(
        cx,
        vec![source, dest, error.clone_ref()],
        move |cx, c, _| {
            let mut actions = Vec::new();
            if !prevent_abort {
                actions.push(if writable::state_of(cx, c[1].raw())? == WState::Writable {
                    writable::abort_stream(cx, c[1].raw(), c[2].raw())?
                } else {
                    js::resolved(cx, js::UNDEFINED)?
                });
            }
            if !prevent_cancel {
                actions.push(if state(cx, c[0].raw())? == State::Readable {
                    cancel_stream(cx, c[0].raw(), c[2].raw())?
                } else {
                    js::resolved(cx, js::UNDEFINED)?
                });
            }
            let all = js::new_array(cx, actions)?;
            let g = js::global(cx);
            let promise = js::get(cx, g.raw(), "Promise")?;
            js::invoke(cx, promise.raw(), "all", &[all.raw()])
        },
    )?;
    pipe_shutdown_with_action(cx, p, action, Some(error))
}

/// Waits for the writes in flight unless the destination cannot take
/// them, then runs `rest`.
fn pipe_after_writes(cx: Ctx, p: Raw, rest: V) -> R<()> {
    let (dest, current) = {
        let st = pipe(cx, p)?;
        (st.dest.clone_ref(), st.current_write.clone_ref())
    };
    if writable::state_of(cx, dest.raw())? == WState::Writable
        && !writable::close_queued_or_in_flight(cx, dest.raw())?
    {
        let p = js::then(cx, current.raw(), rest.raw(), rest.raw())?;
        js::mark_handled(cx, p.raw());
        Ok(())
    } else {
        js::call(cx, rest.raw(), js::UNDEFINED, &[])?;
        Ok(())
    }
}

fn pipe_shutdown_with_action(cx: Ctx, p: Raw, action: V, error: Option<V>) -> R<()> {
    {
        let mut st = pipe(cx, p)?;
        if st.shutting_down {
            return Ok(());
        }
        st.shutting_down = true;
    }
    let is_error = error.is_some();
    let error = error.unwrap_or_default();
    let rest = js::closure(cx, vec![V::dup(cx, p), action, error], move |cx, c, _| {
        let result = js::promise_of(cx, || js::call(cx, c[1].raw(), js::UNDEFINED, &[]))?;
        js::upon(
            cx,
            result.raw(),
            vec![c[0].clone_ref(), c[2].clone_ref()],
            move |cx, c, _| pipe_finalize(cx, c[0].raw(), is_error.then(|| c[1].clone_ref())),
            |cx, c, e| pipe_finalize(cx, c[0].raw(), Some(V::dup(cx, e))),
        )?;
        Ok(V::undefined())
    })?;
    pipe_after_writes(cx, p, rest)
}

fn pipe_shutdown(cx: Ctx, p: Raw, error: Option<V>) -> R<()> {
    {
        let mut st = pipe(cx, p)?;
        if st.shutting_down {
            return Ok(());
        }
        st.shutting_down = true;
    }
    let is_error = error.is_some();
    let rest = js::closure(
        cx,
        vec![V::dup(cx, p), error.unwrap_or_default()],
        move |cx, c, _| {
            pipe_finalize(cx, c[0].raw(), is_error.then(|| c[1].clone_ref()))?;
            Ok(V::undefined())
        },
    )?;
    pipe_after_writes(cx, p, rest)
}

fn pipe_finalize(cx: Ctx, p: Raw, error: Option<V>) -> R<()> {
    let (writer, reader, signal, id, resolve, reject) = {
        let st = pipe(cx, p)?;
        (
            st.writer.clone_ref(),
            st.reader.clone_ref(),
            st.signal.clone_ref(),
            st.abort_algorithm,
            st.promise.resolve.clone_ref(),
            st.promise.reject.clone_ref(),
        )
    };
    writable::writer_release(cx, writer.raw())?;
    if !common(cx, reader.raw())?.stream.is_undefined() {
        release_reader(cx, reader.raw())?;
    }
    if !signal.is_undefined() {
        crate::web::event::remove_algorithm(cx, signal.raw(), id)?;
    }
    match error {
        Some(e) => js::call(cx, reject.raw(), js::UNDEFINED, &[e.raw()])?,
        None => js::call(cx, resolve.raw(), js::UNDEFINED, &[js::UNDEFINED])?,
    };
    Ok(())
}

// --- Async iteration ------------------------------------------------------

struct AsyncIter {
    reader: V,
    prevent_cancel: bool,
    ongoing: V,
    finished: bool,
}

trace!(AsyncIter { reader, ongoing });

impl Object for AsyncIter {}

fn async_iter<'a>(cx: Ctx, v: Raw) -> R<RefMut<'a, AsyncIter>> {
    data::<AsyncIter>(cx, v, "ReadableStream async iterator")
}

native!(
    fn stream_values(cx, this, args) {
        stream(cx, this)?;
        let options = args.get(0);
        let prevent_cancel = if js::is_object(options) {
            let p = js::get(cx, options, "preventCancel")?;
            js::to_bool(cx, p.raw())
        } else {
            false
        };
        let reader = acquire_default_reader(cx, this)?;
        instance(
            cx,
            js::UNDEFINED,
            Class::ReadableStreamAsyncIterator,
            AsyncIter {
                reader,
                prevent_cancel,
                ongoing: V::undefined(),
                finished: false,
            },
        )
    }
);

/// The next steps of `next()`: `{ value, done }`'s promise.
fn async_iter_next_steps(cx: Ctx, it: Raw) -> R<V> {
    let (finished, reader) = {
        let i = async_iter(cx, it)?;
        (i.finished, i.reader.clone_ref())
    };
    if finished {
        let r = js::iter_result(cx, V::undefined(), true)?;
        return js::resolved(cx, r.raw());
    }
    if common(cx, reader.raw())?.stream.is_undefined() {
        let e = js::type_error_value(cx, "the iterator's reader was released");
        return js::rejected(cx, e.raw());
    }
    let d = Deferred::new(cx)?;
    let request = ReadRequest::steps(
        cx,
        vec![V::dup(cx, it), d.resolve.clone_ref(), d.reject.clone_ref()],
        |cx, c, chunk| {
            async_iter(cx, c[0].raw())?.ongoing = V::undefined();
            let r = js::iter_result(cx, V::dup(cx, chunk), false)?;
            js::call(cx, c[1].raw(), js::UNDEFINED, &[r.raw()])?;
            Ok(())
        },
        |cx, c, _| {
            let reader = {
                let mut i = async_iter(cx, c[0].raw())?;
                i.ongoing = V::undefined();
                i.finished = true;
                i.reader.clone_ref()
            };
            release_reader(cx, reader.raw())?;
            let r = js::iter_result(cx, V::undefined(), true)?;
            js::call(cx, c[1].raw(), js::UNDEFINED, &[r.raw()])?;
            Ok(())
        },
        |cx, c, e| {
            let reader = {
                let mut i = async_iter(cx, c[0].raw())?;
                i.ongoing = V::undefined();
                i.finished = true;
                i.reader.clone_ref()
            };
            release_reader(cx, reader.raw())?;
            js::call(cx, c[2].raw(), js::UNDEFINED, &[e])?;
            Ok(())
        },
    )?;
    default_reader_read(cx, reader.raw(), request)?;
    Ok(d.promise)
}

/// The return steps of `return(value)`.
fn async_iter_return_steps(cx: Ctx, it: Raw, value: Raw) -> R<V> {
    let (finished, reader, prevent_cancel) = {
        let mut i = async_iter(cx, it)?;
        let f = i.finished;
        i.finished = true;
        (f, i.reader.clone_ref(), i.prevent_cancel)
    };
    let done = js::iter_result(cx, V::dup(cx, value), true)?;
    if finished {
        return js::resolved(cx, done.raw());
    }
    if common(cx, reader.raw())?.stream.is_undefined() {
        return js::resolved(cx, done.raw());
    }
    let result = if prevent_cancel {
        release_reader(cx, reader.raw())?;
        js::resolved(cx, js::UNDEFINED)?
    } else {
        let s = common(cx, reader.raw())?.stream.clone_ref();
        let r = cancel_stream(cx, s.raw(), value)?;
        release_reader(cx, reader.raw())?;
        r
    };
    let give_done = js::closure(cx, vec![done], |_, c, _| Ok(c[0].clone_ref()))?;
    js::then(cx, result.raw(), give_done.raw(), js::UNDEFINED)
}

native!(
    fn async_iter_next(cx, this, args) {
        js::promise_of(cx, || {
            let ongoing = async_iter(cx, this)?.ongoing.clone_ref();
            let next = if ongoing.is_undefined() {
                async_iter_next_steps(cx, this)?
            } else {
                let steps = js::closure(cx, vec![V::dup(cx, this)], |cx, c, _| async_iter_next_steps(cx, c[0].raw()))?;
                js::then(cx, ongoing.raw(), steps.raw(), steps.raw())?
            };
            async_iter(cx, this)?.ongoing = next.clone_ref();
            Ok(next)
        })
    }
);

native!(
    fn async_iter_return(cx, this, args) {
        js::promise_of(cx, || {
            let value = args.get(0);
            let ongoing = async_iter(cx, this)?.ongoing.clone_ref();
            let result = if ongoing.is_undefined() {
                async_iter_return_steps(cx, this, value)?
            } else {
                let steps = js::closure(cx, vec![V::dup(cx, this), V::dup(cx, value)], |cx, c, _| {
                    async_iter_return_steps(cx, c[0].raw(), c[1].raw())
                })?;
                js::then(cx, ongoing.raw(), steps.raw(), steps.raw())?
            };
            async_iter(cx, this)?.ongoing = result.clone_ref();
            Ok(result)
        })
    }
);

native!(
    fn async_iter_self(cx, this, args) {
        Ok(V::dup(cx, this))
    }
);

// --- ReadableStream.from --------------------------------------------------

struct FromIter {
    iterator: V,
    next: V,
    /// A sync iterator (its values are awaited).
    sync: bool,
}

trace!(FromIter { iterator, next });

native!(
    fn stream_from(cx, this, args) {
        let iterable = args.get(0);
        if js::is_nullish(iterable) {
            return Err(js::type_error(cx, "ReadableStream.from needs an iterable"));
        }
        let async_method = js::get_atom(cx, iterable, rquickjs::qjs::JS_ATOM_Symbol_asyncIterator as _)?;
        let (method, sync) = if js::is_nullish(async_method.raw()) {
            let m = js::get_atom(cx, iterable, rquickjs::qjs::JS_ATOM_Symbol_iterator as _)?;
            if !js::is_function(cx, m.raw()) {
                return Err(js::type_error(cx, "the value is not iterable"));
            }
            (m, true)
        } else {
            if !js::is_function(cx, async_method.raw()) {
                return Err(js::type_error(cx, "Symbol.asyncIterator is not a function"));
            }
            (async_method, false)
        };
        let iterator = js::call(cx, method.raw(), iterable, &[])?;
        if !js::is_object(iterator.raw()) {
            return Err(js::type_error(cx, "the iterator is not an object"));
        }
        let next = js::get(cx, iterator.raw(), "next")?;
        let state = new_internal(cx, FromIter { iterator, next, sync })?;
        let pull = js::closure(cx, vec![state.clone_ref()], |cx, c, args| {
            let controller = V::dup(cx, args.get(0));
            let (iterator, next, sync) = {
                let s = internal::<FromIter>(cx, c[0].raw())?;
                (s.iterator.clone_ref(), s.next.clone_ref(), s.sync)
            };
            let result = match js::call(cx, next.raw(), iterator.raw(), &[]) {
                Ok(r) => r,
                Err(_) => return js::rejected_with_exception(cx),
            };
            let p = js::resolved(cx, result.raw())?;
            let on_result = js::closure(cx, vec![controller], move |cx, c, args| {
                let r = args.get(0);
                if !js::is_object(r) {
                    return Err(js::type_error(cx, "the iterator result is not an object"));
                }
                let done = js::get(cx, r, "done")?;
                if js::to_bool(cx, done.raw()) {
                    dc_close(cx, c[0].raw())?;
                    return Ok(V::undefined());
                }
                let value = js::get(cx, r, "value")?;
                if sync {
                    // Async-from-sync: the value is awaited.
                    let enqueue = js::closure(cx, vec![c[0].clone_ref()], |cx, c, args| {
                        dc_enqueue(cx, c[0].raw(), args.get(0))?;
                        Ok(V::undefined())
                    })?;
                    return js::then(cx, value.raw(), enqueue.raw(), js::UNDEFINED);
                }
                dc_enqueue(cx, c[0].raw(), value.raw())?;
                Ok(V::undefined())
            })?;
            js::then(cx, p.raw(), on_result.raw(), js::UNDEFINED)
        })?;
        let cancel = js::closure(cx, vec![state], |cx, c, args| {
            let iterator = internal::<FromIter>(cx, c[0].raw())?.iterator.clone_ref();
            js::promise_of(cx, || {
                let Some(ret) = js::get_method(cx, iterator.raw(), "return")? else {
                    return Ok(V::undefined());
                };
                let r = js::call(cx, ret.raw(), iterator.raw(), &[args.get(0)])?;
                let p = js::resolved(cx, r.raw())?;
                let check = js::closure(cx, Vec::new(), |cx, _, args| {
                    if !js::is_object(args.get(0)) {
                        return Err(js::type_error(cx, "the iterator's return result is not an object"));
                    }
                    Ok(V::undefined())
                })?;
                js::then(cx, p.raw(), check.raw(), js::UNDEFINED)
            })
        })?;
        let (s, _) = new_default_stream(cx, Algo::default(), Algo::native(pull), Algo::native(cancel), 0.0, V::undefined())?;
        Ok(s)
    }
);

/// Reads all of `s` (a byte stream, or a stream of byte chunks): a
/// promise of a Uint8Array (`fetch` bodies).
pub(crate) fn read_all_bytes(cx: Ctx, s: Raw) -> R<V> {
    let reader = acquire_default_reader(cx, s)?;
    let d = Deferred::new(cx)?;
    let promise = d.promise.clone_ref();
    let acc = std::rc::Rc::new(std::cell::RefCell::new(Vec::<u8>::new()));
    read_all_step(cx, reader, d, acc)?;
    Ok(promise)
}

fn read_all_step(
    cx: Ctx,
    reader: V,
    d: Deferred,
    acc: std::rc::Rc<std::cell::RefCell<Vec<u8>>>,
) -> R<()> {
    let (a1, a2) = (acc.clone(), acc);
    let request = ReadRequest::steps(
        cx,
        vec![
            reader.clone_ref(),
            d.promise.clone_ref(),
            d.resolve.clone_ref(),
            d.reject.clone_ref(),
        ],
        move |cx, c, chunk| {
            let Some(bytes) =
                (unsafe { js::bytes_of(cx, chunk) }).filter(|_| js::view(cx, chunk).is_some())
            else {
                let e = js::type_error_value(
                    cx,
                    "the body stream gave a chunk that is not a Uint8Array",
                );
                let reader = c[0].clone_ref();
                let s = common(cx, reader.raw())?.stream.clone_ref();
                let _ = cancel_stream(cx, s.raw(), e.raw());
                js::call(cx, c[3].raw(), js::UNDEFINED, &[e.raw()])?;
                return Ok(());
            };
            a1.borrow_mut().extend_from_slice(bytes);
            let d = Deferred {
                promise: c[1].clone_ref(),
                resolve: c[2].clone_ref(),
                reject: c[3].clone_ref(),
            };
            read_all_step(cx, c[0].clone_ref(), d, a1.clone())
        },
        move |cx, c, _| {
            let bytes = std::mem::take(&mut *a2.borrow_mut());
            let out = js::uint8_array(cx, &bytes)?;
            js::call(cx, c[2].raw(), js::UNDEFINED, &[out.raw()])?;
            Ok(())
        },
        |cx, c, e| {
            js::call(cx, c[3].raw(), js::UNDEFINED, &[e])?;
            Ok(())
        },
    )?;
    default_reader_read(cx, reader.raw(), request)
}

pub(crate) const SPECS: &[Spec] = &[
    Spec {
        class: Class::ReadableStream,
        name: c"ReadableStream",
        parent: None,
        constructor: Some((stream_constructor, 0)),
        methods: &[
            (Key::Name(c"cancel"), stream_cancel, 0),
            (Key::Name(c"getReader"), stream_get_reader, 0),
            (Key::Name(c"pipeThrough"), stream_pipe_through, 1),
            (Key::Name(c"pipeTo"), stream_pipe_to, 1),
            (Key::Name(c"tee"), stream_tee, 0),
            (Key::Name(c"values"), stream_values, 0),
            (Key::AsyncIterator, stream_values, 0),
        ],
        accessors: &[(c"locked", stream_locked, None)],
        statics: &[(c"from", stream_from, 1)],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "<R = any>",
            members: r#"constructor(underlyingSource: UnderlyingByteSource, strategy?: { highWaterMark?: number });
constructor(underlyingSource?: UnderlyingDefaultSource<R>, strategy?: QueuingStrategy<R>);
static from<R>(iterable: Iterable<R | PromiseLike<R>> | AsyncIterable<R>): ReadableStream<R>;
readonly locked: boolean;
cancel(reason?: any): Promise<void>;
getReader(options: { mode: "byob" }): ReadableStreamBYOBReader;
getReader(): ReadableStreamDefaultReader<R>;
pipeThrough<T>(transform: { writable: WritableStream<R>; readable: ReadableStream<T> }, options?: StreamPipeOptions): ReadableStream<T>;
pipeTo(destination: WritableStream<R>, options?: StreamPipeOptions): Promise<void>;
tee(): [ReadableStream<R>, ReadableStream<R>];
values(options?: { preventCancel?: boolean }): AsyncIterableIterator<R>;
[Symbol.asyncIterator](options?: { preventCancel?: boolean }): AsyncIterableIterator<R>;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::ReadableStreamDefaultReader,
        name: c"ReadableStreamDefaultReader",
        parent: None,
        constructor: Some((default_reader_constructor, 1)),
        methods: &[
            (Key::Name(c"read"), default_reader_read_method, 0),
            (Key::Name(c"releaseLock"), reader_release_lock, 0),
            (Key::Name(c"cancel"), reader_cancel, 0),
        ],
        accessors: &[(c"closed", reader_closed, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "<R = any>",
            members: r#"constructor(stream: ReadableStream<R>);
readonly closed: Promise<void>;
read(): Promise<ReadableStreamReadResult<R>>;
releaseLock(): void;
cancel(reason?: any): Promise<void>;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::ReadableStreamBYOBReader,
        name: c"ReadableStreamBYOBReader",
        parent: None,
        constructor: Some((byob_reader_constructor, 1)),
        methods: &[
            (Key::Name(c"read"), byob_reader_read_method, 1),
            (Key::Name(c"releaseLock"), reader_release_lock, 0),
            (Key::Name(c"cancel"), reader_cancel, 0),
        ],
        accessors: &[(c"closed", reader_closed, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"constructor(stream: ReadableStream<Uint8Array>);
readonly closed: Promise<void>;
read<T extends ArrayBufferView>(view: T, options?: { min?: number }): Promise<ReadableStreamReadResult<T>>;
releaseLock(): void;
cancel(reason?: any): Promise<void>;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::ReadableStreamDefaultController,
        name: c"ReadableStreamDefaultController",
        parent: None,
        constructor: None,
        methods: &[
            (Key::Name(c"close"), dc_close_method, 0),
            (Key::Name(c"enqueue"), dc_enqueue_method, 0),
            (Key::Name(c"error"), dc_error_method, 0),
        ],
        accessors: &[(c"desiredSize", dc_desired_size_get, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "<R = any>",
            members: r#"readonly desiredSize: number | null;
close(): void;
enqueue(chunk?: R): void;
error(e?: any): void;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::ReadableByteStreamController,
        name: c"ReadableByteStreamController",
        parent: None,
        constructor: None,
        methods: &[
            (Key::Name(c"close"), bc_close_method, 0),
            (Key::Name(c"enqueue"), bc_enqueue_method, 1),
            (Key::Name(c"error"), bc_error_method, 0),
        ],
        accessors: &[
            (c"byobRequest", bc_byob_request_get, None),
            (c"desiredSize", bc_desired_size_get, None),
        ],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"readonly byobRequest: ReadableStreamBYOBRequest | null;
readonly desiredSize: number | null;
close(): void;
enqueue(chunk: ArrayBufferView): void;
error(e?: any): void;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::ReadableStreamBYOBRequest,
        name: c"ReadableStreamBYOBRequest",
        parent: None,
        constructor: None,
        methods: &[
            (Key::Name(c"respond"), byob_request_respond, 1),
            (
                Key::Name(c"respondWithNewView"),
                byob_request_respond_with_new_view,
                1,
            ),
        ],
        accessors: &[(c"view", byob_request_view, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"readonly view: ArrayBufferView | null;
respond(bytesWritten: number): void;
respondWithNewView(view: ArrayBufferView): void;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::ReadableStreamAsyncIterator,
        name: c"ReadableStreamAsyncIterator",
        parent: None,
        constructor: None,
        methods: &[
            (Key::Name(c"next"), async_iter_next, 0),
            (Key::Name(c"return"), async_iter_return, 0),
            (Key::AsyncIterator, async_iter_self, 0),
        ],
        accessors: &[],
        statics: &[],
        constants: &[],
        global: false,
        ts: crate::web::ClassTs::NONE,
    },
    Spec {
        class: Class::Internal,
        name: c"Internal",
        parent: None,
        constructor: None,
        methods: &[],
        accessors: &[],
        statics: &[],
        constants: &[],
        global: false,
        ts: crate::web::ClassTs::NONE,
    },
];

/// The TypeScript types of this file's classes (`globals.d.ts`).
pub(crate) const TYPES: &str = r#"interface UnderlyingDefaultSource<R = any> {
  start?(controller: ReadableStreamDefaultController<R>): any;
  pull?(controller: ReadableStreamDefaultController<R>): void | PromiseLike<void>;
  cancel?(reason?: any): void | PromiseLike<void>;
  type?: undefined;
}

interface UnderlyingByteSource {
  type: "bytes";
  autoAllocateChunkSize?: number;
  start?(controller: ReadableByteStreamController): any;
  pull?(controller: ReadableByteStreamController): void | PromiseLike<void>;
  cancel?(reason?: any): void | PromiseLike<void>;
}

type ReadableStreamReadResult<T> = { done: false; value: T } | { done: true; value?: T };

interface StreamPipeOptions {
  preventAbort?: boolean;
  preventCancel?: boolean;
  preventClose?: boolean;
  signal?: AbortSignal;
}
"#;
