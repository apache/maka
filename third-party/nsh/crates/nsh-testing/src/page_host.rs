//! The web page's host in headless runs ([`TestRun::page_host`]): the
//! module `nsh.json` `web.host` names, answering the `nsh/host` calls of
//! the apps tests open.
//!
//! The module is the page's as it is: its `createHost(player)` runs in a
//! QuickJS context of its own, on a thread of its own, once per app opened
//! (a page loads it once per app), before the app starts. What it returns
//! answers every `Command::HostCall` with a `Host` `{ type: "reply" }`, as
//! `nsh.js`'s `hostCall` does on the page: always, `ok: false` with the
//! message when `call` throws, rejects or returns what is not JSON.
//! Every `Command::HostPost` goes to its `post`, or to its `call` without
//! one, the result and failures dropped, as `nsh.js`'s `hostPost` does.
//! `player.hostEvent(event, payload)` sends `Host` `{ type: "event" }`;
//! what is sent before the app's engine runs waits and reaches it in order
//! once it does. The context has `console` (the log's target `js`, as the
//! app's), `setTimeout` / `setInterval` and their `clear*` on the app's
//! clock (a manual one moves them as it moves the app's timers), and
//! nothing of the browser's;
//! imports do not resolve (the page loads the module as it is, so its
//! imports are absolute URLs a headless run cannot load either).
//!
//! [`TestRun::page_host`]: crate::TestRun::page_host

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{EventKind, EventPayload, JsonValue, ROOT_ID};
use nsh_engine::{Clock, EngineControl};
use rquickjs::{CatchResultExt as _, Ctx, Function, Module, Object, Value};

/// The page's host of one app: where its calls go, and where the host's
/// replies and events go.
#[derive(Clone)]
pub(crate) struct PageHost {
    calls: Sender<Call>,
    target: Arc<Target>,
}

impl PageHost {
    /// Loads the module at `path` and runs its `createHost(player)`. Fails
    /// when the module does not load, exports no `createHost`, or what
    /// `createHost` returns (or resolves with, as far as its promise
    /// settles at once) has no `call`.
    pub(crate) fn start(path: &Path, clock: Clock) -> Result<PageHost, String> {
        let source = std::fs::read_to_string(path)
            .map_err(|e| format!("nsh.json web.host {}: {e}", path.display()))?;
        let name = path.display().to_string();
        let target = Arc::new(Target::default());
        let (calls, rx) = crossbeam_channel::unbounded();
        let (loaded, load) = crossbeam_channel::bounded(1);
        let thread_target = target.clone();
        std::thread::Builder::new()
            .name("nsh-test-page-host".into())
            .spawn(move || run(&name, source, clock, thread_target, rx, loaded))
            .map_err(|e| e.to_string())?;
        load.recv()
            .unwrap_or_else(|_| Err("the host module stopped".into()))
            .map_err(|e| format!("nsh.json web.host {}: {e}", path.display()))?;
        Ok(PageHost { calls, target })
    }

    /// The app runs on `control`: delivers what waited, then everything as
    /// it comes.
    pub(crate) fn attach(&self, control: EngineControl) {
        self.target.attach(control);
    }

    /// The app's call `id` of the host's function `name` with `args`.
    pub(crate) fn call(&self, id: u64, name: &str, args: &JsonValue) {
        let _ = self.calls.send(Call {
            id: Some(id),
            name: name.to_owned(),
            args: args.clone(),
        });
    }

    /// The app's post to the host's function `name` with `args`.
    pub(crate) fn post(&self, name: &str, args: &JsonValue) {
        let _ = self.calls.send(Call {
            id: None,
            name: name.to_owned(),
            args: args.clone(),
        });
    }
}

/// Where the module's replies and events go: the engine once it runs; what
/// is sent before waits, in order, as the page holds events sent before
/// the app runs.
#[derive(Default)]
struct Target(Mutex<TargetState>);

#[derive(Default)]
struct TargetState {
    control: Option<EngineControl>,
    pending: Vec<JsonValue>,
}

impl Target {
    fn attach(&self, control: EngineControl) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for value in state.pending.drain(..) {
            control.dispatch_event(ROOT_ID, EventKind::Host, EventPayload::Json(value));
        }
        state.control = Some(control);
    }

    fn send(&self, value: JsonValue) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match &state.control {
            Some(control) => {
                control.dispatch_event(ROOT_ID, EventKind::Host, EventPayload::Json(value))
            }
            None => state.pending.push(value),
        }
    }
}

/// A call the app made: `Command::HostCall`'s fields, or
/// `Command::HostPost`'s without an id.
struct Call {
    id: Option<u64>,
    name: String,
    args: JsonValue,
}

/// What the module's context runs before the module: the timers and the
/// player, and how calls are answered and posts taken (as `nsh.js`
/// `hostCall` and `hostPost`).
const GLUE: &str = r#"
(() => {
  const timers = new Map();
  let nextTimer = 1;
  const add = (f, ms, args, repeat) => {
    const id = nextTimer++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { f, args, delay, repeat, due: __nshNow() + delay });
    return id;
  };
  globalThis.setTimeout = (f, ms, ...args) => add(f, ms, args, false);
  globalThis.setInterval = (f, ms, ...args) => add(f, ms, args, true);
  globalThis.clearTimeout = globalThis.clearInterval = (id) => { timers.delete(id); };
  const print = (level) => (...args) => __nshLog(level, args.map(String).join(" "));
  globalThis.console = { log: print("info"), info: print("info"), warn: print("warn"), error: print("error") };

  // Runs the timers that are due; when the next one is (ms since the start), or -1.
  globalThis.__nshTimers = (now) => {
    for (const [id, t] of [...timers]) {
      if (t.due > now || !timers.has(id)) continue;
      if (t.repeat) t.due = now + Math.max(1, t.delay);
      else timers.delete(id);
      try {
        t.f(...t.args);
      } catch (e) {
        console.error(`web.host timer: ${e?.message ?? e}`);
      }
    }
    let next = -1;
    for (const t of timers.values()) if (next < 0 || t.due < next) next = t.due;
    return next;
  };

  const player = {
    hostEvent(event, payload = null) {
      __nshSend(JSON.stringify({ type: "event", event: String(event), payload: payload ?? null }));
    },
  };
  let ready;
  let failed = "";
  globalThis.__nshInstall = (evaluated, module) => {
    ready = evaluated.then(() => {
      if (typeof module.createHost !== "function") throw new Error("the module exports no createHost(player)");
      return module.createHost(player);
    }).then((host) => {
      if (typeof host?.call !== "function") throw new Error("createHost(player) returned no call(name, args)");
      return host;
    });
    ready.catch((e) => { failed = String(e?.message ?? e); });
  };
  globalThis.__nshFailed = () => failed;
  globalThis.__nshCall = async (id, name, args) => {
    let reply;
    try {
      const host = await ready;
      const value = (await host.call(name, JSON.parse(args))) ?? null;
      reply = JSON.stringify({ type: "reply", id, ok: true, value });
    } catch (e) {
      reply = JSON.stringify({ type: "reply", id, ok: false, error: String(e?.message ?? e) });
    }
    __nshSend(reply);
  };
  globalThis.__nshPost = async (name, args) => {
    try {
      const host = await ready;
      await (typeof host.post === "function" ? host.post(name, JSON.parse(args)) : host.call(name, JSON.parse(args)));
    } catch {}
  };
})();
"#;

fn run(
    name: &str,
    source: String,
    clock: Clock,
    target: Arc<Target>,
    calls: Receiver<Call>,
    loaded: Sender<Result<(), String>>,
) {
    // The module's time: milliseconds of the app's clock since it loaded.
    let origin = clock.now();
    let setup = || -> Result<(rquickjs::Runtime, rquickjs::Context), String> {
        let runtime = rquickjs::Runtime::new().map_err(|e| e.to_string())?;
        let context = rquickjs::Context::full(&runtime).map_err(|e| e.to_string())?;
        context.with(|cx| install(&cx, name, source, &target, &clock, origin))?;
        drain(&runtime);
        let failed: String = context.with(|cx| eval(&cx, "__nshFailed()"))?;
        if !failed.is_empty() {
            return Err(failed);
        }
        Ok((runtime, context))
    };
    let (runtime, context) = match setup() {
        Ok(js) => {
            let _ = loaded.send(Ok(()));
            js
        }
        Err(err) => {
            let _ = loaded.send(Err(err));
            return;
        }
    };
    // The clock's alarms wake the thread when the next timer is due.
    let (wake, woken) = crossbeam_channel::unbounded::<()>();
    let mut alarm: Option<f64> = None;
    loop {
        let next = context
            .with(|cx| {
                let f: Function = cx.globals().get("__nshTimers")?;
                f.call::<_, f64>((ms(&clock, origin),))
            })
            .unwrap_or(-1.0);
        drain(&runtime);
        if next >= 0.0 && alarm.is_none_or(|at| next < at) {
            alarm = Some(next);
            let wake = wake.clone();
            clock.at(origin + Duration::from_secs_f64(next / 1000.0), move || {
                let _ = wake.send(());
            });
        }
        crossbeam_channel::select! {
            recv(calls) -> call => {
                // The app closed.
                let Ok(call) = call else { return };
                let answered = context.with(|cx| -> Result<(), String> {
                    let args = call.args.to_string();
                    let called = match call.id {
                        Some(id) => cx
                            .globals()
                            .get::<_, Function>("__nshCall")
                            .and_then(|f| f.call::<_, Value>((id as f64, call.name, args))),
                        None => cx
                            .globals()
                            .get::<_, Function>("__nshPost")
                            .and_then(|f| f.call::<_, Value>((call.name, args))),
                    };
                    called.catch(&cx).map_err(|e| e.to_string())?;
                    Ok(())
                });
                if let Err(err) = answered {
                    log::error!(target: "js", "web.host: {err}");
                }
            }
            recv(woken) -> _ => alarm = None,
        }
        drain(&runtime);
    }
}

/// Defines the glue and its native functions, then loads the module and
/// starts its `createHost`.
fn install(
    cx: &Ctx<'_>,
    name: &str,
    source: String,
    target: &Arc<Target>,
    clock: &Clock,
    origin: Instant,
) -> Result<(), String> {
    let error = |e: rquickjs::Error| e.to_string();
    let globals = cx.globals();
    let send = {
        let target = target.clone();
        move |json: String| match serde_json::from_str(&json) {
            Ok(value) => target.send(value),
            Err(err) => log::error!(target: "js", "web.host: {err}"),
        }
    };
    globals
        .set("__nshSend", Function::new(cx.clone(), send).map_err(error)?)
        .map_err(error)?;
    globals
        .set(
            "__nshNow",
            Function::new(cx.clone(), {
                let clock = clock.clone();
                move || ms(&clock, origin)
            })
            .map_err(error)?,
        )
        .map_err(error)?;
    globals
        .set(
            "__nshLog",
            Function::new(cx.clone(), |level: String, message: String| {
                let level = match level.as_str() {
                    "error" => log::Level::Error,
                    "warn" => log::Level::Warn,
                    _ => log::Level::Info,
                };
                log::log!(target: "js", level, "{message}");
            })
            .map_err(error)?,
        )
        .map_err(error)?;
    eval::<Value>(cx, GLUE)?;
    let (module, evaluated) = Module::declare(cx.clone(), name, source)
        .and_then(Module::eval)
        .catch(cx)
        .map_err(|e| e.to_string())?;
    let namespace: Object = module.namespace().map_err(error)?;
    let install: Function = globals.get("__nshInstall").map_err(error)?;
    install
        .call::<_, Value>((evaluated, namespace))
        .catch(cx)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn eval<'js, V: rquickjs::FromJs<'js>>(cx: &Ctx<'js>, source: &str) -> Result<V, String> {
    cx.eval::<V, _>(source).catch(cx).map_err(|e| e.to_string())
}

/// Runs the promise jobs that are queued.
fn drain(runtime: &rquickjs::Runtime) {
    while runtime.is_job_pending() {
        if let Err(err) = runtime.execute_pending_job() {
            log::error!(target: "js", "web.host: {err}");
        }
    }
}

/// Milliseconds of `clock` since `origin`.
fn ms(clock: &Clock, origin: Instant) -> f64 {
    clock.now().duration_since(origin).as_secs_f64() * 1000.0
}
