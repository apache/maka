//! `Event`, `CustomEvent`, `EventTarget`, `AbortController` and
//! `AbortSignal` (DOM Standard). A target has no tree: dispatch reaches
//! the target only (capture listeners first, as the DOM does at the
//! target).

use std::{cell::Cell, rc::Rc};

use super::{
    Class, Key, Object, Spec, data, instance,
    js::{self, Ctx, R, Raw, V, native, trace},
    role,
};

const AT_TARGET: f64 = 2.0;

/// An event (`CustomEvent`s too: `detail`).
pub(crate) struct Event {
    kind: String,
    bubbles: bool,
    cancelable: bool,
    composed: bool,
    trusted: bool,
    /// `defaultPrevented`.
    canceled: bool,
    stop_propagation: bool,
    stop_immediate: bool,
    in_passive: bool,
    dispatching: bool,
    phase: u8,
    target: V,
    current_target: V,
    time: f64,
    detail: V,
}

trace!(Event {
    target,
    current_target,
    detail
});

impl Object for Event {}

/// A listener of a target.
struct Listener {
    kind: String,
    /// The function or `{ handleEvent }` (undefined for an event handler
    /// attribute, `onabort`: its current value is called).
    callback: V,
    capture: bool,
    once: bool,
    passive: bool,
    /// Removed (a dispatch in progress skips it).
    removed: Rc<Cell<bool>>,
}

trace!(Listener { callback });

/// The `EventTarget` part of an object.
#[derive(Default)]
pub(crate) struct Target {
    listeners: Vec<Listener>,
    /// Event handler attributes (`onabort`), by event type.
    handlers: Vec<(String, V)>,
}

trace!(Target {
    listeners,
    handlers
});

impl Object for Target {
    fn target(&mut self) -> Option<&mut Target> {
        Some(self)
    }
}

impl Target {
    fn remove(&mut self, kind: &str, callback: Raw, capture: bool) {
        if let Some(i) = self.listeners.iter().position(|l| {
            l.kind == kind && l.capture == capture && js::same(l.callback.raw(), callback)
        }) {
            let l = self.listeners.remove(i);
            l.removed.set(true);
        }
    }

    /// Sets event handler attribute `kind` (`null` removes it).
    pub(crate) fn set_handler(&mut self, cx: Ctx, kind: &str, value: Raw) {
        let callable = js::is_object(value);
        match self.handlers.iter_mut().find(|(k, _)| k == kind) {
            Some((_, v)) if callable => *v = V::dup(cx, value),
            Some(_) => {
                self.handlers.retain(|(k, _)| k != kind);
                if let Some(i) = self
                    .listeners
                    .iter()
                    .position(|l| l.kind == kind && l.callback.is_undefined())
                {
                    self.listeners.remove(i).removed.set(true);
                }
            }
            None if callable => {
                self.handlers.push((kind.to_owned(), V::dup(cx, value)));
                self.listeners.push(Listener {
                    kind: kind.to_owned(),
                    callback: V::undefined(),
                    capture: false,
                    once: false,
                    passive: false,
                    removed: Rc::default(),
                });
            }
            None => {}
        }
    }

    pub(crate) fn handler(&self, cx: Ctx, kind: &str) -> V {
        self.handlers
            .iter()
            .find(|(k, _)| k == kind)
            .map_or_else(V::null, |(_, v)| V::dup(cx, v.raw()))
    }
}

fn target<'a>(cx: Ctx, v: Raw) -> R<std::cell::RefMut<'a, Target>> {
    role(cx, v, "EventTarget", |o| o.target())
}

/// `performance.now()`.
fn now(cx: Ctx) -> f64 {
    let g = js::global(cx);
    js::get(cx, g.raw(), "performance")
        .and_then(|p| js::invoke(cx, p.raw(), "now", &[]))
        .and_then(|n| js::to_number(cx, n.raw()))
        .unwrap_or(0.0)
}

fn new_event_data(cx: Ctx, kind: String, bubbles: bool, cancelable: bool, composed: bool) -> Event {
    Event {
        kind,
        bubbles,
        cancelable,
        composed,
        trusted: false,
        canceled: false,
        stop_propagation: false,
        stop_immediate: false,
        in_passive: false,
        dispatching: false,
        phase: 0,
        target: V::null(),
        current_target: V::null(),
        time: now(cx),
        detail: V::null(),
    }
}

/// An `EventInit`'s flags.
fn event_init(cx: Ctx, init: Raw) -> R<(bool, bool, bool)> {
    if js::is_nullish(init) {
        return Ok((false, false, false));
    }
    if !js::is_object(init) {
        return Err(js::type_error(cx, "EventInit must be an object"));
    }
    let flag = |name| js::get(cx, init, name).map(|v| js::to_bool(cx, v.raw()));
    Ok((flag("bubbles")?, flag("cancelable")?, flag("composed")?))
}

native!(
    fn event_constructor(cx, this, args) {
        if args.len() == 0 {
            return Err(js::type_error(cx, "Event requires a type"));
        }
        let kind = js::to_string(cx, args.get(0))?;
        let (bubbles, cancelable, composed) = event_init(cx, args.get(1))?;
        let data = new_event_data(cx, kind, bubbles, cancelable, composed);
        instance(cx, this, Class::Event, data)
    }
);

native!(
    fn custom_event_constructor(cx, this, args) {
        if args.len() == 0 {
            return Err(js::type_error(cx, "CustomEvent requires a type"));
        }
        let kind = js::to_string(cx, args.get(0))?;
        let init = args.get(1);
        let (bubbles, cancelable, composed) = event_init(cx, init)?;
        let mut data = new_event_data(cx, kind, bubbles, cancelable, composed);
        if js::is_object(init) {
            data.detail = js::get(cx, init, "detail")?;
            if data.detail.is_undefined() {
                data.detail = V::null();
            }
        }
        instance(cx, this, Class::CustomEvent, data)
    }
);

fn event<'a>(cx: Ctx, v: Raw) -> R<std::cell::RefMut<'a, Event>> {
    data::<Event>(cx, v, "Event")
}

macro_rules! event_getter {
    ($name:ident, |$cx:ident, $e:ident| $body:expr) => {
        native!(
            fn $name($cx, this, args) {
                let $e = event($cx, this)?;
                Ok($body)
            }
        );
    };
}

event_getter!(event_type, |cx, e| js::string(cx, &e.kind)?);
event_getter!(event_target, |cx, e| V::dup(cx, e.target.raw()));
event_getter!(event_current_target, |cx, e| V::dup(
    cx,
    e.current_target.raw()
));
event_getter!(event_phase, |cx, e| V::num(f64::from(e.phase)));
event_getter!(event_bubbles, |cx, e| V::bool(e.bubbles));
event_getter!(event_cancelable, |cx, e| V::bool(e.cancelable));
event_getter!(event_default_prevented, |cx, e| V::bool(e.canceled));
event_getter!(event_composed, |cx, e| V::bool(e.composed));
event_getter!(event_is_trusted, |cx, e| V::bool(e.trusted));
event_getter!(event_time_stamp, |cx, e| V::num(e.time));
event_getter!(event_return_value, |cx, e| V::bool(!e.canceled));
event_getter!(event_cancel_bubble, |cx, e| V::bool(e.stop_propagation));
event_getter!(event_detail, |cx, e| V::dup(cx, e.detail.raw()));

impl Event {
    fn prevent_default(&mut self) {
        if self.cancelable && !self.in_passive {
            self.canceled = true;
        }
    }
}

native!(
    fn event_set_return_value(cx, this, args) {
        if !js::to_bool(cx, args.get(0)) {
            event(cx, this)?.prevent_default();
        }
        Ok(V::undefined())
    }
);

native!(
    fn event_set_cancel_bubble(cx, this, args) {
        if js::to_bool(cx, args.get(0)) {
            event(cx, this)?.stop_propagation = true;
        }
        Ok(V::undefined())
    }
);

native!(
    fn event_prevent_default(cx, this, args) {
        event(cx, this)?.prevent_default();
        Ok(V::undefined())
    }
);

native!(
    fn event_stop_propagation(cx, this, args) {
        event(cx, this)?.stop_propagation = true;
        Ok(V::undefined())
    }
);

native!(
    fn event_stop_immediate_propagation(cx, this, args) {
        let mut e = event(cx, this)?;
        e.stop_propagation = true;
        e.stop_immediate = true;
        Ok(V::undefined())
    }
);

native!(
    fn event_composed_path(cx, this, args) {
        let current = {
            let e = event(cx, this)?;
            (!e.current_target.is_nullish()).then(|| V::dup(cx, e.current_target.raw()))
        };
        js::new_array(cx, current.into_iter().collect())
    }
);

native!(
    /// `initEvent(type, bubbles, cancelable)` (legacy).
    fn event_init_event(cx, this, args) {
        let kind = js::to_string(cx, args.get(0))?;
        let mut e = event(cx, this)?;
        if !e.dispatching {
            e.kind = kind;
            e.bubbles = js::to_bool(cx, args.get(1));
            e.cancelable = js::to_bool(cx, args.get(2));
            e.canceled = false;
            e.stop_propagation = false;
            e.stop_immediate = false;
            e.trusted = false;
            e.target = V::null();
        }
        Ok(V::undefined())
    }
);

// --- EventTarget ----------------------------------------------------------

native!(
    fn target_constructor(cx, this, args) {
        instance(cx, this, Class::EventTarget, Target::default())
    }
);

/// The flags of `addEventListener`'s options: capture, once, passive,
/// signal.
fn listener_options(cx: Ctx, options: Raw) -> R<(bool, bool, bool, Option<V>)> {
    if !js::is_object(options) {
        return Ok((js::to_bool(cx, options), false, false, None));
    }
    let flag = |name| js::get(cx, options, name).map(|v| js::to_bool(cx, v.raw()));
    let (capture, once, passive) = (flag("capture")?, flag("once")?, flag("passive")?);
    let signal = js::get(cx, options, "signal")?;
    let signal = if signal.is_undefined() {
        None
    } else if super::is::<Signal>(cx, signal.raw()) {
        Some(signal)
    } else {
        return Err(js::type_error(cx, "signal is not an AbortSignal"));
    };
    Ok((capture, once, passive, signal))
}

/// `removeEventListener`'s capture flag.
fn capture_option(cx: Ctx, options: Raw) -> R<bool> {
    if js::is_object(options) {
        let c = js::get(cx, options, "capture")?;
        Ok(js::to_bool(cx, c.raw()))
    } else {
        Ok(js::to_bool(cx, options))
    }
}

native!(
    fn add_event_listener(cx, this, args) {
        let kind = js::to_string(cx, args.get(0))?;
        let callback = args.get(1);
        let (capture, once, passive, signal) = listener_options(cx, args.get(2))?;
        if js::is_nullish(callback) {
            return Ok(V::undefined());
        }
        if !js::is_object(callback) {
            return Err(js::type_error(cx, "the listener is not an object"));
        }
        if let Some(s) = &signal
            && aborted(cx, s.raw())?
        {
            return Ok(V::undefined());
        }
        {
            let mut t = target(cx, this)?;
            let exists = t.listeners.iter().any(|l| {
                l.kind == kind && l.capture == capture && js::same(l.callback.raw(), callback)
            });
            if exists {
                return Ok(V::undefined());
            }
            t.listeners.push(Listener {
                kind: kind.clone(),
                callback: V::dup(cx, callback),
                capture,
                once,
                passive,
                removed: Rc::default(),
            });
        }
        if let Some(s) = signal {
            // Aborting the signal removes the listener.
            let captures = vec![V::dup(cx, this), V::dup(cx, callback)];
            let remove = js::closure(cx, captures, move |cx, c, _| {
                target(cx, c[0].raw())?.remove(&kind, c[1].raw(), capture);
                Ok(V::undefined())
            })?;
            add_algorithm(cx, s.raw(), remove)?;
        }
        Ok(V::undefined())
    }
);

native!(
    fn remove_event_listener(cx, this, args) {
        let kind = js::to_string(cx, args.get(0))?;
        let capture = capture_option(cx, args.get(2))?;
        target(cx, this)?.remove(&kind, args.get(1), capture);
        Ok(V::undefined())
    }
);

native!(
    fn dispatch_event(cx, this, args) {
        let e = args.get(0);
        if !super::is::<Event>(cx, e) {
            return Err(js::type_error(cx, "dispatchEvent needs an Event"));
        }
        event(cx, e)?.trusted = false;
        dispatch(cx, this, e).map(V::bool)
    }
);

/// A listener as a dispatch saw it: callback, capture, once, passive, and
/// its removed flag.
type Snapshot = (V, bool, bool, bool, Rc<Cell<bool>>);

/// Dispatches event `e` at `target`: whether it was not canceled.
pub(crate) fn dispatch(cx: Ctx, target_obj: Raw, e: Raw) -> R<bool> {
    let kind = {
        let mut ev = event(cx, e)?;
        if ev.dispatching {
            return Err(js::throw_dom(
                cx,
                "The event is already being dispatched.",
                "InvalidStateError",
            ));
        }
        ev.dispatching = true;
        ev.target = V::dup(cx, target_obj);
        ev.current_target = V::dup(cx, target_obj);
        ev.phase = AT_TARGET as u8;
        ev.kind.clone()
    };
    // The listeners as they are now; removals during dispatch still apply.
    let snapshot: Vec<Snapshot> = target(cx, target_obj)?
        .listeners
        .iter()
        .filter(|l| l.kind == kind)
        .map(|l| {
            (
                l.callback.clone_ref(),
                l.capture,
                l.once,
                l.passive,
                l.removed.clone(),
            )
        })
        .collect();
    'phases: for capture_phase in [true, false] {
        for (callback, capture, once, passive, removed) in &snapshot {
            if *capture != capture_phase || removed.get() {
                continue;
            }
            if *once {
                target(cx, target_obj)?.remove(&kind, callback.raw(), *capture);
            }
            let callback = if callback.is_undefined() {
                // An event handler attribute: its current value.
                target(cx, target_obj)?.handler(cx, &kind)
            } else {
                callback.clone_ref()
            };
            event(cx, e)?.in_passive = *passive;
            let result = if js::is_function(cx, callback.raw()) {
                js::call(cx, callback.raw(), target_obj, &[e])
            } else if js::is_object(callback.raw()) {
                js::get(cx, callback.raw(), "handleEvent").and_then(|h| {
                    if js::is_function(cx, h.raw()) {
                        js::call(cx, h.raw(), callback.raw(), &[e])
                    } else {
                        Err(js::type_error(cx, "handleEvent is not a function"))
                    }
                })
            } else {
                Ok(V::undefined())
            };
            if result.is_err() {
                js::report_exception(cx);
            }
            let mut ev = event(cx, e)?;
            ev.in_passive = false;
            if ev.stop_immediate {
                break 'phases;
            }
        }
    }
    let mut ev = event(cx, e)?;
    ev.dispatching = false;
    ev.phase = 0;
    ev.current_target = V::null();
    ev.stop_propagation = false;
    ev.stop_immediate = false;
    Ok(!ev.canceled)
}

/// Fires a trusted event `kind` at `target`.
pub(crate) fn fire(cx: Ctx, target_obj: Raw, kind: &str) -> R<bool> {
    let e = trusted(cx, kind)?;
    dispatch(cx, target_obj, e.raw())
}

/// A new trusted event `kind`, not dispatched yet.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub(crate) fn trusted(cx: Ctx, kind: &str) -> R<V> {
    let mut data = new_event_data(cx, kind.to_owned(), false, false, false);
    data.trusted = true;
    instance(cx, js::UNDEFINED, Class::Event, data)
}

// --- AbortSignal ----------------------------------------------------------

/// An abort signal.
#[derive(Default)]
pub(crate) struct Signal {
    target: Target,
    aborted: bool,
    reason: V,
    /// What runs on abort (the specs' abort algorithms), by id.
    algorithms: Vec<(u32, V)>,
    next_algorithm: u32,
    /// `AbortSignal.any`'s: made from other signals.
    dependent: bool,
    sources: Vec<V>,
    /// `WeakRef`s of the signals made from this one.
    dependents: Vec<V>,
}

trace!(Signal {
    target,
    reason,
    algorithms,
    sources,
    dependents
});

impl Object for Signal {
    fn target(&mut self) -> Option<&mut Target> {
        Some(&mut self.target)
    }
}

fn signal<'a>(cx: Ctx, v: Raw) -> R<std::cell::RefMut<'a, Signal>> {
    data::<Signal>(cx, v, "AbortSignal")
}

/// A new signal, not aborted.
pub(crate) fn new_signal(cx: Ctx) -> R<V> {
    instance(cx, js::UNDEFINED, Class::AbortSignal, Signal::default())
}

/// Whether `v` is an AbortSignal.
pub(crate) fn is_signal(cx: Ctx, v: Raw) -> bool {
    super::is::<Signal>(cx, v)
}

/// Whether signal `s` is aborted.
pub(crate) fn aborted(cx: Ctx, s: Raw) -> R<bool> {
    Ok(signal(cx, s)?.aborted)
}

/// Signal `s`'s abort reason.
pub(crate) fn reason(cx: Ctx, s: Raw) -> R<V> {
    Ok(signal(cx, s)?.reason.clone_ref())
}

/// Runs `f` when signal `s` aborts; its id, to remove it.
pub(crate) fn add_algorithm(cx: Ctx, s: Raw, f: V) -> R<u32> {
    let mut sig = signal(cx, s)?;
    if sig.aborted {
        return Ok(u32::MAX);
    }
    sig.next_algorithm += 1;
    let id = sig.next_algorithm;
    sig.algorithms.push((id, f));
    Ok(id)
}

/// Removes abort algorithm `id` of `s`.
pub(crate) fn remove_algorithm(cx: Ctx, s: Raw, id: u32) -> R<()> {
    let removed = {
        let mut sig = signal(cx, s)?;
        sig.algorithms
            .iter()
            .position(|(i, _)| *i == id)
            .map(|i| sig.algorithms.remove(i))
    };
    // Freed after the borrow (a finalizer may run).
    drop(removed);
    Ok(())
}

fn default_reason(cx: Ctx) -> R<V> {
    js::dom_exception(cx, "signal is aborted without reason", "AbortError")
}

/// Aborts signal `s` with `reason` (`undefined`: an `AbortError`).
pub(crate) fn abort(cx: Ctx, s: Raw, reason: Raw) -> R<()> {
    let reason = if js::is_undefined(reason) {
        default_reason(cx)?
    } else {
        V::dup(cx, reason)
    };
    let weak = {
        let mut sig = signal(cx, s)?;
        if sig.aborted {
            return Ok(());
        }
        sig.aborted = true;
        sig.reason = reason.clone_ref();
        std::mem::take(&mut sig.dependents)
    };
    let mut dependents = Vec::new();
    for w in weak {
        let d = js::invoke(cx, w.raw(), "deref", &[])?;
        if js::is_undefined(d.raw()) {
            continue;
        }
        let mut dep = signal(cx, d.raw())?;
        if !dep.aborted {
            dep.aborted = true;
            dep.reason = reason.clone_ref();
            drop(dep);
            dependents.push(d);
        }
    }
    run_abort_steps(cx, s)?;
    for d in dependents {
        run_abort_steps(cx, d.raw())?;
    }
    Ok(())
}

fn run_abort_steps(cx: Ctx, s: Raw) -> R<()> {
    let algorithms = std::mem::take(&mut signal(cx, s)?.algorithms);
    for (_, f) in algorithms {
        if js::call(cx, f.raw(), js::UNDEFINED, &[]).is_err() {
            js::report_exception(cx);
        }
    }
    fire(cx, s, "abort")?;
    Ok(())
}

native!(
    fn signal_aborted(cx, this, args) {
        Ok(V::bool(signal(cx, this)?.aborted))
    }
);

native!(
    fn signal_reason(cx, this, args) {
        Ok(signal(cx, this)?.reason.clone_ref())
    }
);

native!(
    fn signal_throw_if_aborted(cx, this, args) {
        let sig = signal(cx, this)?;
        if sig.aborted {
            let reason = sig.reason.clone_ref();
            drop(sig);
            return Err(js::throw(cx, reason));
        }
        Ok(V::undefined())
    }
);

native!(
    fn signal_onabort(cx, this, args) {
        Ok(target(cx, this)?.handler(cx, "abort"))
    }
);

native!(
    fn signal_set_onabort(cx, this, args) {
        target(cx, this)?.set_handler(cx, "abort", args.get(0));
        Ok(V::undefined())
    }
);

native!(
    fn signal_abort(cx, this, args) {
        let s = new_signal(cx)?;
        abort(cx, s.raw(), args.get(0))?;
        Ok(s)
    }
);

native!(
    fn signal_timeout(cx, this, args) {
        let ms = js::to_number(cx, args.get(0))?;
        if !ms.is_finite() || ms < 0.0 {
            return Err(js::type_error(cx, "the timeout must be a non-negative number"));
        }
        let s = new_signal(cx)?;
        let fire = js::closure(cx, vec![s.clone_ref()], |cx, c, _| {
            let reason = js::dom_exception(cx, "signal timed out", "TimeoutError")?;
            abort(cx, c[0].raw(), reason.raw())?;
            Ok(V::undefined())
        })?;
        let g = js::global(cx);
        let set_timeout = js::get(cx, g.raw(), "setTimeout")?;
        js::call(cx, set_timeout.raw(), js::UNDEFINED, &[fire.raw(), V::num(ms).raw()])?;
        Ok(s)
    }
);

native!(
    fn signal_any(cx, this, args) {
        let mut signals = Vec::new();
        js::for_each(cx, args.get(0), |s| {
            if !is_signal(cx, s.raw()) {
                return Err(js::type_error(cx, "AbortSignal.any takes AbortSignals"));
            }
            signals.push(s);
            Ok(())
        })?;
        let result = new_signal(cx)?;
        for s in &signals {
            let sig = signal(cx, s.raw())?;
            if sig.aborted {
                let reason = sig.reason.clone_ref();
                drop(sig);
                let mut r = signal(cx, result.raw())?;
                r.aborted = true;
                r.reason = reason;
                drop(r);
                return Ok(result);
            }
        }
        signal(cx, result.raw())?.dependent = true;
        let g = js::global(cx);
        let weak_ref = js::get(cx, g.raw(), "WeakRef")?;
        for s in &signals {
            // A dependent signal's sources stand for it.
            let sources = {
                let sig = signal(cx, s.raw())?;
                if sig.dependent {
                    sig.sources.iter().map(V::clone_ref).collect()
                } else {
                    vec![s.clone_ref()]
                }
            };
            for source in sources {
                let already = signal(cx, result.raw())?
                    .sources
                    .iter()
                    .any(|x| js::same(x.raw(), source.raw()));
                if already {
                    continue;
                }
                let weak = js::construct(cx, weak_ref.raw(), &[result.raw()])?;
                let stale = {
                    let mut src = signal(cx, source.raw())?;
                    src.dependents.push(weak);
                    // Dependents that were collected: dropped now and then.
                    src.dependents.len() > 32
                };
                if stale {
                    prune(cx, source.raw())?;
                }
                signal(cx, result.raw())?.sources.push(source);
            }
        }
        Ok(result)
    }
);

/// Drops the collected dependents of `s`.
fn prune(cx: Ctx, s: Raw) -> R<()> {
    let weak = std::mem::take(&mut signal(cx, s)?.dependents);
    let mut alive = Vec::with_capacity(weak.len());
    for w in weak {
        let d = js::invoke(cx, w.raw(), "deref", &[])?;
        if !js::is_undefined(d.raw()) {
            alive.push(w);
        }
    }
    signal(cx, s)?.dependents.extend(alive);
    Ok(())
}

// --- AbortController ------------------------------------------------------

struct Controller {
    signal: V,
}

trace!(Controller { signal });

impl Object for Controller {}

native!(
    fn controller_constructor(cx, this, args) {
        let signal = new_signal(cx)?;
        instance(cx, this, Class::AbortController, Controller { signal })
    }
);

native!(
    fn controller_signal(cx, this, args) {
        Ok(data::<Controller>(cx, this, "AbortController")?.signal.clone_ref())
    }
);

native!(
    fn controller_abort(cx, this, args) {
        let s = data::<Controller>(cx, this, "AbortController")?.signal.clone_ref();
        abort(cx, s.raw(), args.get(0))?;
        Ok(V::undefined())
    }
);

const EVENT_ACCESSORS: &[(&std::ffi::CStr, js::Native, Option<js::Native>)] = &[
    (c"type", event_type, None),
    (c"target", event_target, None),
    (c"srcElement", event_target, None),
    (c"currentTarget", event_current_target, None),
    (c"eventPhase", event_phase, None),
    (c"bubbles", event_bubbles, None),
    (c"cancelable", event_cancelable, None),
    (c"defaultPrevented", event_default_prevented, None),
    (c"composed", event_composed, None),
    (c"isTrusted", event_is_trusted, None),
    (c"timeStamp", event_time_stamp, None),
    (
        c"returnValue",
        event_return_value,
        Some(event_set_return_value),
    ),
    (
        c"cancelBubble",
        event_cancel_bubble,
        Some(event_set_cancel_bubble),
    ),
];

pub(crate) const SPECS: &[Spec] = &[
    Spec {
        class: Class::EventTarget,
        name: c"EventTarget",
        parent: None,
        constructor: Some((target_constructor, 0)),
        methods: &[
            (Key::Name(c"addEventListener"), add_event_listener, 2),
            (Key::Name(c"removeEventListener"), remove_event_listener, 2),
            (Key::Name(c"dispatchEvent"), dispatch_event, 1),
        ],
        accessors: &[],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"constructor();
addEventListener(
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: AddEventListenerOptions | boolean,
): void;
removeEventListener(
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: { capture?: boolean } | boolean,
): void;
dispatchEvent(event: Event): boolean;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::Event,
        name: c"Event",
        parent: None,
        constructor: Some((event_constructor, 1)),
        methods: &[
            (Key::Name(c"composedPath"), event_composed_path, 0),
            (Key::Name(c"stopPropagation"), event_stop_propagation, 0),
            (
                Key::Name(c"stopImmediatePropagation"),
                event_stop_immediate_propagation,
                0,
            ),
            (Key::Name(c"preventDefault"), event_prevent_default, 0),
            (Key::Name(c"initEvent"), event_init_event, 1),
        ],
        accessors: EVENT_ACCESSORS,
        statics: &[],
        constants: &[
            (c"NONE", 0.0),
            (c"CAPTURING_PHASE", 1.0),
            (c"AT_TARGET", AT_TARGET),
            (c"BUBBLING_PHASE", 3.0),
        ],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"constructor(type: string, init?: EventInit);
readonly type: string;
readonly target: EventTarget | null;
readonly currentTarget: EventTarget | null;
readonly eventPhase: number;
readonly bubbles: boolean;
readonly cancelable: boolean;
readonly defaultPrevented: boolean;
readonly composed: boolean;
readonly isTrusted: boolean;
readonly timeStamp: number;
returnValue: boolean;
/** `target` (legacy). */
readonly srcElement: EventTarget | null;
/** Sets `type`, `bubbles` and `cancelable` of an event not dispatched yet (legacy). */
initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void;
cancelBubble: boolean;
composedPath(): EventTarget[];
preventDefault(): void;
stopPropagation(): void;
stopImmediatePropagation(): void;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::CustomEvent,
        name: c"CustomEvent",
        parent: Some(Class::Event),
        constructor: Some((custom_event_constructor, 1)),
        methods: &[],
        accessors: &[(c"detail", event_detail, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "<T = any> extends Event",
            members: r#"constructor(type: string, init?: EventInit & { detail?: T });
readonly detail: T;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::AbortSignal,
        name: c"AbortSignal",
        parent: Some(Class::EventTarget),
        constructor: None,
        methods: &[(Key::Name(c"throwIfAborted"), signal_throw_if_aborted, 0)],
        accessors: &[
            (c"aborted", signal_aborted, None),
            (c"reason", signal_reason, None),
            (c"onabort", signal_onabort, Some(signal_set_onabort)),
        ],
        statics: &[
            (c"abort", signal_abort, 0),
            (c"timeout", signal_timeout, 1),
            (c"any", signal_any, 1),
        ],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: " extends EventTarget",
            members: r#"readonly aborted: boolean;
readonly reason: any;
onabort: ((event: Event) => void) | null;
throwIfAborted(): void;
static abort(reason?: any): AbortSignal;
static timeout(milliseconds: number): AbortSignal;
static any(signals: Iterable<AbortSignal>): AbortSignal;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::AbortController,
        name: c"AbortController",
        parent: None,
        constructor: Some((controller_constructor, 0)),
        methods: &[(Key::Name(c"abort"), controller_abort, 0)],
        accessors: &[(c"signal", controller_signal, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"readonly signal: AbortSignal;
abort(reason?: any): void;"#,
        }
        .declared(),
    },
];

/// The TypeScript types of this file's classes (`globals.d.ts`).
pub(crate) const TYPES: &str = r#"type EventListenerOrEventListenerObject = ((event: Event) => void) | { handleEvent(event: Event): void };

interface AddEventListenerOptions {
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
  signal?: AbortSignal;
}

interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}
"#;
