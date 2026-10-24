//! `nsh/host`: the app's side of the message channel with the embedding
//! app (`nsh_core::host_channel`; the engine's `HostChannel` is the
//! embedding app's side).
//!
//! `host.params` is the embedding app's launch parameters, made once per
//! VM from [`HostBridge::params`]. `host.on(name, listener)` hears the
//! embedding app's events: the engine hands each to [`deliver`], which
//! calls the listeners of its name, or keeps it in the VM's inbox until a
//! listener of that name is added (a job then delivers what was kept, at
//! the end of the turn that added it). `host.call(name, data)` is a
//! promise the embedding app's answer settles ([`settle`], by the call's
//! id); `host.post(name, data)` hands data over without one. Data crosses
//! as JSON values converted natively (no `JSON` in JS), and the limits are
//! checked here: names ([`check_name`]), the depth and size of data
//! (`protocol::to_json`), the calls waiting at once
//! ([`MAX_PENDING_CALLS`]) and the events kept ([`HostInbox`]).

use std::{
    cell::{Cell, RefCell},
    ffi::c_int,
    rc::Rc,
    time::Duration,
};

use nsh_core::{
    JsonValue,
    host_channel::{HostBridge, HostInbox, MAX_PENDING_CALLS, check_name},
};
use rquickjs::qjs;
use rustc_hash::FxHashMap;

use crate::web::js::{
    self, Args, Ctx, Deferred, R, Raw, Throw, UNDEFINED, V, closure, native, type_error,
};

/// A listener of the embedding app's events.
struct Listener {
    id: u32,
    name: String,
    f: V,
}

/// A native call and its deadline on the app's clock.
struct PendingCall {
    deferred: Deferred,
    name: String,
    timeout: f64,
    deadline: Option<nsh_core::time::Instant>,
}

/// A context's side of the channel.
#[derive(Default)]
pub(crate) struct HostChannel {
    /// The listeners, oldest first.
    listeners: RefCell<Vec<Listener>>,
    next: Cell<u32>,
    /// The events no listener heard yet.
    inbox: RefCell<HostInbox>,
    /// The calls waiting for the embedding app's answers, by id.
    calls: RefCell<FxHashMap<u64, PendingCall>>,
    next_call: Cell<u64>,
}

impl HostChannel {
    /// Frees the listeners and the calls' promises (the state is
    /// unregistered).
    pub(crate) fn free_all(&self) {
        let listeners = std::mem::take(&mut *self.listeners.borrow_mut());
        drop(listeners);
        let calls = std::mem::take(&mut *self.calls.borrow_mut());
        drop(calls);
    }
}

fn channel<'a>(cx: Ctx) -> &'a HostChannel {
    // SAFETY: a projection of the state's field, by shared reference.
    unsafe { &(*crate::state::state(cx)).host_channel }
}

/// The engine's bridge to the embedding app, if this VM has one.
fn bridge(cx: Ctx) -> Option<Rc<dyn HostBridge>> {
    crate::dom::shared(cx).host_bridge.borrow().clone()
}

/// A message name argument of `what`, checked.
fn name_arg(cx: Ctx, v: Raw, what: &str) -> R<String> {
    // SAFETY: an inline tag check.
    if !unsafe { qjs::JS_IsString(v) } {
        return Err(type_error(cx, &format!("{what}: the name is a string")));
    }
    let name = js::to_string(cx, v)?;
    check_name(&name).map_err(|e| type_error(cx, &format!("{what}: {e}")))?;
    Ok(name)
}

/// `v` as JSON (`undefined`: `null`); throws a `RangeError` for data
/// nested too deep or too large.
fn to_json(cx: Ctx, v: Raw) -> R<JsonValue> {
    if js::is_undefined(v) {
        return Ok(JsonValue::Null);
    }
    // SAFETY: a context reference and a dup for the converter.
    let rcx = unsafe { rquickjs::Ctx::from_raw(std::ptr::NonNull::new_unchecked(cx)) };
    let value = unsafe { rquickjs::Value::from_raw(rcx, qjs::JS_DupValue(cx, v)) };
    crate::protocol::to_json(&value).map_err(|_| Throw)
}

/// JSON as a JS value.
fn from_json(cx: Ctx, json: &JsonValue) -> V {
    V::own(cx, crate::host::json_to_js(cx, json))
}

/// A new `Error(message)`.
fn error(cx: Ctx, message: &str) -> R<V> {
    let global = js::global(cx);
    let class = js::get(cx, global.raw(), "Error")?;
    let message = js::string(cx, message)?;
    js::construct(cx, class.raw(), &[message.raw()])
}

/// Whether a native SDK channel is configured alongside the platform.
pub(crate) fn available(cx: Ctx) -> bool {
    bridge(cx).is_some_and(|b| b.available())
}

/// Adds the SDK channel to the existing capability-gated platform module.
/// Platform calls (notably the web player) keep the registry's transport.
pub(crate) fn extend(cx: Ctx, host: Raw) -> Raw {
    let obj = V::own(cx, host);
    let made = (|| -> R<V> {
        let platform_call = js::get(cx, obj.raw(), "call")?;
        let call = closure(cx, vec![platform_call], |cx, captures, args| {
            if available(cx) {
                return match start_call(cx, args) {
                    Ok(promise) => Ok(promise),
                    Err(Throw) => js::rejected_with_exception(cx),
                };
            }
            let arguments: Vec<_> = (0..args.len()).map(|i| args.get(i)).collect();
            js::call(cx, captures[0].raw(), UNDEFINED, &arguments)
        })?;
        js::define(cx, obj.raw(), "call", call, true)?;
        let platform_on = js::get(cx, obj.raw(), "on")?;
        let on = closure(cx, vec![platform_on], |cx, captures, args| {
            let native_on = js::function(cx, c"on", on, 2)?;
            let arguments = [args.get(0), args.get(1)];
            let native_off = js::call(cx, native_on.raw(), UNDEFINED, &arguments)?;
            let platform_sub = js::call(cx, captures[0].raw(), UNDEFINED, &arguments)?;
            let platform_off = js::get(cx, platform_sub.raw(), "remove")?;
            let off = closure(
                cx,
                vec![native_off, platform_sub, platform_off],
                |cx, values, _| {
                    js::call(cx, values[0].raw(), UNDEFINED, &[])?;
                    js::call(cx, values[2].raw(), values[1].raw(), &[])?;
                    Ok(V::undefined())
                },
            )?;
            // Keep main's subscription form and the SDK's cleanup function.
            js::define(cx, off.raw(), "remove", off.clone_ref(), true)?;
            crate::keymap::undo_with_owner(cx, &off);
            Ok(off)
        })?;
        js::define(cx, obj.raw(), "on", on, true)?;
        let params = bridge(cx)
            .map(|b| b.params())
            .filter(JsonValue::is_object)
            .unwrap_or_else(|| JsonValue::Object(Default::default()));
        js::define(cx, obj.raw(), "params", from_json(cx, &params), true)?;
        js::define(
            cx,
            obj.raw(),
            "post",
            js::function(cx, c"post", post, 2)?,
            true,
        )?;
        Ok(obj)
    })();
    made.map_or(qjs::JS_EXCEPTION, V::take)
}

native! {
    /// `on(name, listener)`: a function that stops listening, which goes by
    /// itself with the owner it was added under (as `keymap.bind`'s
    /// bindings do).
    fn on(cx, _this, args) {
        let name = name_arg(cx, args.get(0), "host.on")?;
        if !js::is_function(cx, args.get(1)) {
            return Err(type_error(cx, "host.on: the listener is not a function"));
        }
        let state = channel(cx);
        let id = state.next.get() + 1;
        state.next.set(id);
        state.listeners.borrow_mut().push(Listener {
            id,
            name: name.clone(),
            f: V::dup(cx, args.get(1)),
        });
        // What came before a listener did goes to it at the end of this
        // turn: after the code adding it (and its neighbors) ran.
        if state.inbox.borrow().has(&name) {
            let name = js::string(cx, &name)?;
            let mut job_args = [name.raw()];
            // SAFETY: the job keeps its own reference to the argument.
            if unsafe { qjs::JS_EnqueueJob(cx, Some(deliver_kept_job), 1, job_args.as_mut_ptr()) } < 0 {
                return Err(Throw);
            }
        }
        let off = closure(cx, Vec::new(), move |cx, _, _| {
            let gone = {
                let mut listeners = channel(cx).listeners.borrow_mut();
                listeners
                    .iter()
                    .position(|l| l.id == id)
                    .map(|i| listeners.remove(i))
            };
            // Freed with no borrow held.
            drop(gone);
            Ok(V::undefined())
        })?;
        crate::keymap::undo_with_owner(cx, &off);
        Ok(off)
    }
}

fn start_call(cx: Ctx, args: Args<'_>) -> R<V> {
    let name = name_arg(cx, args.get(0), "host.call")?;
    check_call(cx, &name)?;
    let options = args.get(2);
    let timeout = if js::is_nullish(options) {
        30_000.0
    } else {
        let value = js::get(cx, options, "timeout")?;
        if js::is_undefined(value.raw()) {
            30_000.0
        } else {
            js::to_number(cx, value.raw())?
        }
    };
    if !timeout.is_finite() || timeout < 0.0 {
        let e = error(cx, &format!("nsh/host: invalid timeout {timeout}"))?;
        return Err(js::throw(cx, e));
    }
    let deadline = (timeout != 0.0)
        .then(|| {
            Duration::try_from_secs_f64(timeout / 1000.0)
                .ok()
                .and_then(|duration| nsh_core::time::now().checked_add(duration))
        })
        .flatten();
    let data = to_json(cx, args.get(1))?;
    let state = channel(cx);
    if state.calls.borrow().len() >= MAX_PENDING_CALLS {
        return Err(js::range_error(
            cx,
            &format!(
                "host.call(\"{name}\"): {MAX_PENDING_CALLS} calls already wait for the embedding app's answers"
            ),
        ));
    }
    let deferred = Deferred::new(cx)?;
    let promise = deferred.promise.clone_ref();
    let id = state.next_call.get() + 1;
    state.next_call.set(id);
    let started = match bridge(cx) {
        Some(bridge) => bridge.call(id, &name, data),
        None => Err("nsh/host: this platform has no host".to_owned()),
    };
    match started {
        Ok(()) => {
            state.calls.borrow_mut().insert(
                id,
                PendingCall {
                    deferred,
                    name,
                    timeout,
                    deadline,
                },
            );
        }
        Err(message) => {
            let e = error(cx, &message)?;
            deferred.reject(cx, e.raw());
        }
    }
    Ok(promise)
}

/// Native SDK calls and posts obey the same names and grants as the
/// platform's `Command::HostCall`, before crossing into host code.
fn check_call(cx: Ctx, name: &str) -> R<()> {
    let message = if !nsh_core::access::valid_host_name(name) {
        Some(format!(
            "nsh/host: invalid function name {name:?} ({})",
            nsh_core::access::HOST_NAME_CHARS
        ))
    } else if !crate::dom::shared(cx)
        .system_access
        .borrow()
        .allows_host(name)
    {
        Some(format!(
            "nsh/host: `{name}` is not granted: add it to capabilities.host in nsh.json"
        ))
    } else {
        None
    };
    if let Some(message) = message {
        log::warn!(target: "js", "{message}");
        let e = error(cx, &message)?;
        return Err(js::throw(cx, e));
    }
    Ok(())
}

/// Earliest native SDK reply deadline, using the app's clock.
pub(crate) fn next_deadline(cx: Ctx) -> Option<nsh_core::time::Instant> {
    channel(cx)
        .calls
        .borrow()
        .values()
        .filter_map(|c| c.deadline)
        .min()
}

/// Rejects expired calls and releases their slots; late replies are ignored.
pub(crate) fn expire(cx: Ctx, now: nsh_core::time::Instant) {
    let expired: Vec<_> = channel(cx)
        .calls
        .borrow()
        .iter()
        .filter(|(_, call)| call.deadline.is_some_and(|at| at <= now))
        .map(|(&id, call)| {
            (
                id,
                format!(
                    "nsh/host: {} timed out after {} ms",
                    call.name, call.timeout
                ),
            )
        })
        .collect();
    for (id, message) in expired {
        settle(cx, id, Err(message));
    }
}

native! {
    /// `post(name, data)`: hands `data` to the embedding app, with no
    /// answer.
    fn post(cx, _this, args) {
        let name = name_arg(cx, args.get(0), "host.post")?;
        let data = to_json(cx, args.get(1))?;
        if let Some(bridge) = bridge(cx).filter(|b| b.available()) {
            check_call(cx, &name)?;
            bridge.post(&name, data);
        }
        Ok(V::undefined())
    }
}

/// The job `on` queues: delivers the events of its name kept so far.
unsafe extern "C" fn deliver_kept_job(cx: Ctx, argc: c_int, argv: *mut Raw) -> Raw {
    // SAFETY: the job's one argument, the name.
    let args = unsafe { Args::new(argc, argv) };
    let Ok(name) = js::to_string(cx, args.get(0)) else {
        return qjs::JS_EXCEPTION;
    };
    while listens(cx, &name) {
        let Some(data) = channel(cx).inbox.borrow_mut().pop(&name) else {
            break;
        };
        // A listener may unsubscribe itself, or dispose its owner. Leave
        // the remaining events in the inbox for the next listener.
        dispatch(cx, &name, &data);
    }
    UNDEFINED
}

/// Whether a listener of `name` is there.
fn listens(cx: Ctx, name: &str) -> bool {
    channel(cx)
        .listeners
        .borrow()
        .iter()
        .any(|l| l.name == name)
}

/// Calls the listeners of `name` with `data`, oldest first; one that
/// throws is reported and the others still run.
fn dispatch(cx: Ctx, name: &str, data: &JsonValue) {
    let listeners: Vec<V> = channel(cx)
        .listeners
        .borrow()
        .iter()
        .filter(|l| l.name == name)
        .map(|l| l.f.clone_ref())
        .collect();
    let data = from_json(cx, data);
    for f in listeners {
        if js::call(cx, f.raw(), UNDEFINED, &[data.raw()]).is_err() {
            js::report_exception(cx);
        }
    }
}

/// The embedding app's event `name`: to its listeners, or kept until one
/// is added.
pub(crate) fn deliver(cx: Ctx, name: &str, data: JsonValue) {
    if listens(cx, name) {
        dispatch(cx, name, &data);
        return;
    }
    let dropped = channel(cx).inbox.borrow_mut().push(name.to_owned(), data);
    if let Some((name, _)) = dropped {
        log::warn!(
            target: "js",
            "nsh/host: the app did not listen to the embedding app's events; the oldest kept (\"{name}\") was dropped"
        );
    }
}

/// Settles call `id` with the embedding app's answer (or why it failed).
pub(crate) fn settle(cx: Ctx, id: u64, result: Result<JsonValue, String>) {
    let Some(call) = channel(cx).calls.borrow_mut().remove(&id) else {
        return;
    };
    let deferred = call.deferred;
    match result {
        Ok(value) => {
            let value = from_json(cx, &value);
            deferred.resolve(cx, value.raw());
        }
        Err(message) => match error(cx, &message) {
            Ok(e) => deferred.reject(cx, e.raw()),
            Err(Throw) => {
                let e = js::take_exception(cx);
                deferred.reject(cx, e.raw());
            }
        },
    }
}

/// `nsh/host`'s types.
pub(crate) const TYPES: &str = r#"/** Data that crosses between the app and the embedding app: a JSON value. */
export type HostValue = null | boolean | number | string | HostValue[] | { [key: string]: HostValue };

/** The embedding app's launch parameters. */
export type HostParams = { readonly [key: string]: HostValue };

/** The channel to the app this one is embedded in (the iOS, Android and
 * desktop SDKs' `NshAppView`, `NshView` and `AppView`). Data crosses as JSON
 * values: what `JSON.stringify` keeps of it (functions and `undefined`
 * fields are left out). */
export interface HostEvents {
  /** Whether the platform or native SDK has a configured host. */
  available(): boolean;
  /** Listens until the subscription is removed. */
  on(event: string, listener: (payload: unknown) => void): { remove(): void };
}

/** A cleanup function with the platform subscription's remove method. */
export interface HostSubscription {
  (): void;
  remove(): void;
}

export interface Host {
  /** Whether the platform or native SDK has a configured host. */
  available(): boolean;
  /** The parameters the embedding app set before it started this app (what
   * to open, who the user is), `{}` when it set none. They are fixed while
   * the app runs; later requests come as events. */
  readonly params: HostParams;
  /** Listens to the embedding app's event `name`: `listener` gets its data
   * (`null` when it sent none), the listeners of a name in the order they
   * were added. Events the embedding app sends while the app has no listener
   * of their name are kept (up to 256, then the oldest go) and come right
   * after the first listener is added, once the code adding it ran. Returns
   * a function that stops listening; a listener added while a component
   * renders stops with the component. */
  on<T = HostValue>(name: string, listener: (data: T) => void): HostSubscription;
  /** Calls the embedding app's handler of `name` with `data`: the promise
   * resolves with its answer, or rejects with an `Error` with the message the
   * handler gave, or at once when the embedding app handles no `name`. At
   * most 1024 calls wait for answers at once; one more rejects with a
   * `RangeError`. */
  call<T = HostValue>(name: string, data?: unknown, options?: { timeout?: number }): Promise<T>;
  /** Hands `data` to the embedding app's handler of `name`, without an
   * answer; it is dropped when the embedding app handles no `name`. */
  post(name: string, data?: unknown): void;
}
"#;

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, rc::Rc};

    use nsh_core::{JsonValue, Op, host_channel::HostBridge};
    use serde_json::json;

    use crate::Host;

    /// The embedding app's side, recording what reaches it.
    #[derive(Default)]
    struct Bridge {
        calls: RefCell<Vec<(u64, String, JsonValue)>>,
        posts: RefCell<Vec<(String, JsonValue)>>,
    }

    impl HostBridge for Bridge {
        fn params(&self) -> JsonValue {
            json!({ "conversation": "c-1", "user": { "id": 7 } })
        }

        fn call(&self, id: u64, name: &str, data: JsonValue) -> Result<(), String> {
            if name == "missing" {
                return Err("no such handler".into());
            }
            self.calls.borrow_mut().push((id, name.into(), data));
            Ok(())
        }

        fn post(&self, name: &str, data: JsonValue) {
            self.posts.borrow_mut().push((name.into(), data));
        }
    }

    fn allow_host(host: &Host) {
        host.set_system_access(
            nsh_core::access::Access {
                declared: nsh_core::access::Capabilities::from_json(&json!({ "host": true }))
                    .unwrap(),
                ..Default::default()
            },
            None,
        );
    }

    const REPORT: &str = r#"import { text } from "nsh:rt";
import { host } from "nsh/host";
const report = (v) => text(String(v));
"#;

    /// The texts reported since the last call.
    fn reported(host: &Host) -> Vec<String> {
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        ops.into_iter()
            .filter_map(|op| match op {
                Op::CreateText { text, .. } => Some(text),
                _ => None,
            })
            .collect()
    }

    fn pending_calls(host: &Host) -> usize {
        host.with_raw(|cx| super::channel(cx).calls.borrow().len())
    }

    #[test]
    fn without_an_embedding_app_params_are_empty_and_posts_are_ignored() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
report(JSON.stringify(host.params));
host.post("seen", {{ a: 1 }});
"#
        ))
        .unwrap();
        host.run_jobs();
        assert_eq!(reported(&host), ["{}"]);
    }

    #[test]
    fn calls_settle_with_the_answers_by_id() {
        let host = Host::new().unwrap();
        let bridge = Rc::new(Bridge::default());
        allow_host(&host);
        host.set_host_bridge(bridge.clone());
        host.eval_source(&format!(
            r#"{REPORT}
report(host.params.conversation + " " + host.params.user.id);
host.call("profile", {{ id: 7, skip: undefined }}).then((v) => report("profile " + v.name));
host.call("save", [1, 2]).catch((e) => report("save " + e.message));
host.call("missing").catch((e) => report("missing " + e.message));
host.post("seen", "home");
"#
        ))
        .unwrap();
        host.run_jobs();
        assert_eq!(reported(&host), ["c-1 7", "missing no such handler"]);
        let calls = bridge.calls.borrow().clone();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].1, "profile");
        assert_eq!(calls[0].2, json!({ "id": 7 }));
        assert_eq!(calls[1].2, json!([1, 2]));
        assert_eq!(*bridge.posts.borrow(), [("seen".to_owned(), json!("home"))]);
        assert_eq!(pending_calls(&host), 2);
        host.host_reply(calls[1].0, Err("disk full".into()));
        host.host_reply(calls[0].0, Ok(json!({ "name": "Ada" })));
        // A second answer, or one for no call, is ignored.
        host.host_reply(calls[0].0, Ok(json!(null)));
        host.host_reply(999, Ok(json!(null)));
        assert_eq!(reported(&host), ["save disk full", "profile Ada"]);
        assert_eq!(pending_calls(&host), 0);
    }

    #[test]
    fn events_wait_for_a_listener_of_their_name() {
        let host = Host::new().unwrap();
        allow_host(&host);
        host.set_host_bridge(Rc::new(Bridge::default()));
        host.eval_source(&format!(
            r#"{REPORT}
globalThis.listen = () => {{
  host.on("open", (d) => report("a " + d.id));
  host.on("open", (d) => report("b " + d.id));
  report("listening");
}};
const off = host.on("tick", (n) => report("tick " + n));
globalThis.stop = () => off();
"#
        ))
        .unwrap();
        host.host_event("open", json!({ "id": 1 }));
        host.host_event("open", json!({ "id": 2 }));
        host.host_event("tick", json!(1));
        assert_eq!(reported(&host), ["tick 1"]);
        // Kept until the listeners are added, then theirs in order, after
        // the code adding them.
        host.eval_source("listen();").unwrap();
        host.run_jobs();
        assert_eq!(reported(&host), ["listening", "a 1", "b 1", "a 2", "b 2"]);
        host.eval_source("stop();").unwrap();
        host.host_event("tick", json!(2));
        assert_eq!(reported(&host), Vec::<String>::new());
    }

    #[test]
    fn kept_events_wait_again_when_the_last_listener_unsubscribes() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
globalThis.listen = () => {{
  const off = host.on("open", (data) => {{ report("first " + data); off(); }});
}};
globalThis.listenAgain = () => host.on("open", (data) => report("next " + data));
"#
        ))
        .unwrap();
        host.host_event("open", json!(1));
        host.host_event("open", json!(2));
        host.host_event("open", json!(3));
        host.eval_source("listen();").unwrap();
        host.run_jobs();
        assert_eq!(reported(&host), ["first 1"]);
        // The first callback removed the only listener. Neither remaining
        // event has been delivered yet; both still wait, in order.
        host.eval_source("listenAgain();").unwrap();
        host.run_jobs();
        assert_eq!(reported(&host), ["next 2", "next 3"]);
    }

    #[test]
    fn native_calls_and_posts_require_the_hosts_capability() {
        let host = Host::new().unwrap();
        let bridge = Rc::new(Bridge::default());
        host.set_host_bridge(bridge.clone());
        host.eval_source(&format!(
            r#"{REPORT}
report(host.available());
host.call("profile").catch(e => report(e.message));
try {{ host.post("profile"); }} catch (e) {{ report(e.message); }}
"#
        ))
        .unwrap();
        host.run_jobs();
        let seen = reported(&host);
        assert_eq!(seen[0], "true");
        assert!(seen[1..].iter().all(|s| s.contains("capabilities.host")));
        assert!(bridge.calls.borrow().is_empty());
        assert!(bridge.posts.borrow().is_empty());
    }

    #[test]
    fn native_timeouts_release_calls_and_ignore_late_replies() {
        let host = Host::new().unwrap();
        allow_host(&host);
        let bridge = Rc::new(Bridge::default());
        host.set_host_bridge(bridge.clone());
        host.eval_source(&format!(
            r#"{REPORT}
host.call("slow", null, {{ timeout: 20 }}).then(report, e => report(e.message));
host.call("wait", null, {{ timeout: 0 }}).then(report);
"#
        ))
        .unwrap();
        assert!(host.next_timer().is_some());
        host.run_timers(nsh_core::time::now() + std::time::Duration::from_millis(50));
        assert_eq!(reported(&host), ["nsh/host: slow timed out after 20 ms"]);
        assert_eq!(pending_calls(&host), 1);
        let calls = bridge.calls.borrow();
        host.host_reply(calls[0].0, Ok(json!("too late")));
        host.host_reply(calls[1].0, Ok(json!("answered")));
        assert_eq!(reported(&host), ["answered"]);
        assert!(host.next_timer().is_none());
    }

    #[test]
    fn names_data_and_waiting_calls_are_limited() {
        let host = Host::new().unwrap();
        allow_host(&host);
        host.set_host_bridge(Rc::new(Bridge::default()));
        host.eval_source(&format!(
            r#"{REPORT}
const fails = (f) => {{ try {{ f(); return "no"; }} catch (e) {{ return e.name; }} }};
report(fails(() => host.on("", () => {{}})));
report(fails(() => host.on("x".repeat(257), () => {{}})));
report(fails(() => host.on("x", 1)));
report(fails(() => host.post(1)));
let deep = 0;
for (let i = 0; i < 100; i++) deep = [deep];
report(fails(() => host.post("deep", deep)));
for (let i = 0; i < {max}; i++) host.call("wait");
host.call("wait").catch((e) => report(e.name));
"#,
            max = nsh_core::host_channel::MAX_PENDING_CALLS
        ))
        .unwrap();
        host.run_jobs();
        assert_eq!(
            reported(&host),
            [
                "TypeError",
                "TypeError",
                "TypeError",
                "TypeError",
                "RangeError",
                "RangeError"
            ]
        );
        assert_eq!(
            pending_calls(&host),
            nsh_core::host_channel::MAX_PENDING_CALLS
        );
    }
}
