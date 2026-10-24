use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use nsh_core::{
    EventKind, EventPayload, NodeId, Op, PayloadValue, TouchPhase, js::Limits,
    platform::Environment, time::Instant,
};
use rquickjs::{
    AsyncRuntime, CatchResultExt, Ctx, Function, Module, Persistent, Promise, Value, function::Opt,
    qjs,
};

use crate::{
    console,
    error::JsError,
    net::{FetchEvent, NetworkQueue, RequestId},
    protocol::Warnings,
    rejections::Rejections,
    sandbox::{self, Budget, Phase},
    standard::scheduler::{Context, Scheduler},
    timers::Timers,
    web,
};

/// Receives JS errors: uncaught exceptions ([`Host::set_error_handler`])
/// or unhandled promise rejections ([`Host::set_rejection_handler`]).
pub type ErrorHandler = Box<dyn Fn(&JsError)>;
type ExitHandler = Rc<dyn Fn(i32)>;

/// State shared between the host and the native functions installed in JS.
/// Only touched on the JS thread.
#[derive(Default)]
pub(crate) struct Shared {
    pub(crate) ops: RefCell<Vec<Op>>,
    /// Native nodes collected since the last [`Host::take_ops`] (their
    /// finalizers queue here: the op queue may be borrowed meanwhile).
    pub(crate) releases: RefCell<Vec<NodeId>>,
    /// Native animation nodes and composites collected meanwhile.
    pub(crate) animation_releases: RefCell<Vec<nsh_core::animation::AnimationOp>>,
    timers: RefCell<Timers>,
    /// Per-VM host delegate for capability-gated exit requests.
    pub(crate) system_exit_handler: RefCell<Option<ExitHandler>>,
    /// The embedding app's side of `nsh/host` (the engine's bridge).
    pub(crate) host_bridge: RefCell<Option<Rc<dyn nsh_core::host_channel::HostBridge>>>,
    pub(crate) system_websocket:
        RefCell<Option<std::sync::Arc<dyn nsh_core::websocket::WebSocketTransport>>>,
    /// Permissions and host-selected app directory for native system operations.
    pub(crate) system_access: RefCell<nsh_core::access::Access>,
    pub(crate) system_filesystem:
        RefCell<Option<std::sync::Arc<dyn nsh_core::filesystem::FileSystem>>>,
    pub(crate) system_data_dir: RefCell<Option<std::path::PathBuf>>,
    pub(crate) system_paths: RefCell<nsh_core::access::TrustedPaths>,
    /// The VM's counts of limited resources for Rust modules (`net`'s
    /// sockets), handed to their calls' `System`.
    pub(crate) system_quotas: nsh_core::ui::Quotas,
    /// The VM's scheduler, for native transports that start its I/O runtime.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub(crate) scheduler: std::rc::Weak<Scheduler>,
    /// The VM's state of the runtime's Rust modules (`process`'s
    /// children), closed when the VM goes.
    pub(crate) system_locals: nsh_core::ui::Locals,
    /// The lazy standard globals installed so far (bits of `standard::LAZY`).
    pub(crate) lazy_globals: Cell<u8>,
    /// Worker completion wakes the owning engine without polling.
    pub(crate) system_wake: RefCell<Option<Arc<dyn Fn() + Send + Sync>>>,
    pub(crate) warnings: RefCell<Warnings>,
    pub(crate) net: RefCell<NetworkQueue>,
    /// Requests whose response bodies were collected unread (finalizers
    /// queue them here; the next [`Host::take_network`] cancels them).
    pub(crate) dropped_fetches: RefCell<Vec<RequestId>>,
    /// Font assets imported by the app, not yet registered.
    pub(crate) fonts: RefCell<Vec<String>>,
    /// `requestAnimationFrame` callbacks waiting for the next frame.
    frames: RefCell<Vec<(u32, Persistent<Function<'static>>)>>,
    next_frame_id: std::cell::Cell<u32>,
    /// Measures one line of text for `measureText` (the engine's text
    /// engine).
    pub(crate) measurer: RefCell<Option<TextMeasurer>>,
    /// The VM's limits.
    pub(crate) limits: Limits,
    /// Why the VM was stopped (out of memory, over a quota): no JS runs
    /// after that.
    pub(crate) fatal: RefCell<Option<String>>,
    /// Rejected promises without a handler, until the end of the turn.
    rejections: RefCell<Rejections>,
}

impl Shared {
    /// Stops the VM for `reason` (the first reason wins).
    pub(crate) fn stop(&self, reason: String) {
        self.fatal.borrow_mut().get_or_insert(reason);
    }
}

/// Measures the width of one line of `text` in `font`, in points.
pub type TextMeasurer =
    Box<dyn Fn(&nsh_core::canvas::CanvasFont, &str) -> nsh_core::geometry::Points>;

/// One QuickJS runtime + context with the nsh host APIs installed.
pub struct Host {
    // Field order matters: the context must drop before the runtime.
    cx: Context,
    rt: RefCell<Option<AsyncRuntime>>,
    scheduler: Rc<Scheduler>,
    /// Set by the heap's allocator when it refuses an allocation.
    exhausted: Arc<AtomicBool>,
    shared: Rc<Shared>,
    on_error: Option<ErrorHandler>,
    on_rejection: Option<ErrorHandler>,
    budget: Budget,
    evaluations: RefCell<Vec<Persistent<Promise<'static>>>>,
    entry_depth: Cell<usize>,
}

/// A context with `JS_NewContext`'s intrinsics. With feature
/// `bytecode-only` without the one that compiles source (`eval`, the
/// function constructors, `Module::declare`): nothing then reaches QuickJS'
/// parser and compiler, which the linker leaves out, and the VM runs
/// bytecode only (the web runtime of published apps).
fn new_context(rt: &AsyncRuntime, scheduler: Rc<Scheduler>) -> rquickjs::Result<Context> {
    #[cfg(test)]
    if tests::SOURCELESS.get() {
        return sourceless_context(rt, scheduler);
    }
    #[cfg(not(feature = "bytecode-only"))]
    {
        Context::full(rt, scheduler)
    }
    #[cfg(feature = "bytecode-only")]
    {
        sourceless_context(rt, scheduler)
    }
}

/// The context of `bytecode-only` runtimes, without the intrinsic that
/// compiles source; tests make one in any build, so a VM setup that needs
/// QuickJS' parser fails them, not only the web runtime.
#[cfg(any(feature = "bytecode-only", test))]
fn sourceless_context(rt: &AsyncRuntime, scheduler: Rc<Scheduler>) -> rquickjs::Result<Context> {
    use rquickjs::context::intrinsic::{
        Date, Json, MapSet, Performance, Promise, Proxy, RegExp, TypedArrays, WeakRef,
    };
    let cx = Context::custom::<(
        Date,
        RegExp,
        Json,
        Proxy,
        MapSet,
        TypedArrays,
        Promise,
        WeakRef,
        Performance,
    )>(rt, scheduler)?;
    // SAFETY: a new, live context; rquickjs has no intrinsic for it.
    cx.with(|cx| unsafe { rquickjs::qjs::JS_AddIntrinsicAToB(cx.as_raw().as_ptr()) });
    Ok(cx)
}

/// How a VM is set up.
#[derive(Debug, Clone, Default)]
pub struct HostOptions {
    /// Resource limits.
    pub limits: Limits,
    /// Removes `eval` and the function constructors and freezes the shared
    /// prototypes (see `sandbox`). Off for development bundles.
    pub harden: bool,
    /// The hardening as bytecode ([`crate::compile_harden`]), run instead
    /// of compiling it: a runtime without QuickJS' parser
    /// (`bytecode-only`) needs it to harden. Trusted input, like a bundle's
    /// bytecode: only from the CLI that compiled the app.
    pub harden_bytecode: Option<std::sync::Arc<Vec<u8>>>,
    /// The UI sets apps import as native modules
    /// (`nsh_base::registry()`, served as `nsh/base`, and an app's own).
    pub ui_sets: Vec<nsh_core::ui::Registry>,
    /// The queue of the JS calls Rust posts (`Callback::post`,
    /// `call_async`): the engine hands the core the same one
    /// ([`nsh_core::Core::set_posts`]), which releases the calls posted
    /// during a synchronous call in order with the ops.
    pub posts: nsh_core::ui::Posts,
    /// The URL relative request URLs (`fetch("/api")`, `new Request("x")`)
    /// resolve against: the page's on the web. `None` (native hosts):
    /// they are invalid, as there is no document they belong to.
    pub base_url: Option<String>,
}

impl Host {
    /// Creates a runtime with the default limits, not hardened, and installs
    /// `console`, timers and the op bridge.
    pub fn new() -> Result<Host, JsError> {
        Self::with_options(HostOptions::default())
    }

    /// Creates a runtime set up by `options` and installs `console`, timers
    /// and the op bridge.
    pub fn with_options(options: HostOptions) -> Result<Host, JsError> {
        let limits = options.limits;
        // The allocator enforces the heap limit (`set_memory_limit` does
        // nothing with one) and tells when it was reached.
        let (allocator, exhausted) = sandbox::HeapAllocator::new(limits.memory_bytes);
        let scheduler = Scheduler::new();
        let rt = AsyncRuntime::new_with_alloc(allocator)?;
        scheduler.ready(rt.set_loader(crate::modules::Resolver, crate::modules::Loader));
        // The engine thread is spawned with a larger stack; keep a margin.
        scheduler.ready(rt.set_max_stack_size(limits.stack_bytes));
        let budget = Budget::new(limits);
        scheduler.ready(rt.set_interrupt_handler(Some(budget.interrupt_handler(None))));
        let cx = new_context(&rt, scheduler.clone())?;
        let shared = Rc::new(Shared {
            limits,
            scheduler: Rc::downgrade(&scheduler),
            ..Shared::default()
        });
        let tracked = shared.clone();
        scheduler.ready(rt.set_host_promise_rejection_tracker(Some(Box::new(
            move |cx, promise, reason, handled| {
                tracked
                    .rejections
                    .borrow_mut()
                    .track(&cx, promise, reason, handled);
            },
        ))));
        cx.with(|cx| {
            crate::state::install(&cx, shared.clone(), &options.ui_sets, options.posts.clone());
            web::web(cx.as_raw().as_ptr()).base_url = options
                .base_url
                .as_deref()
                .and_then(|u| url::Url::parse(u).ok());
            install(&cx, &shared)?;
            crate::standard::install(&cx)?;
            // Before hardening freezes the globals.
            crate::clock::install(&cx)?;
            if options.harden {
                match &options.harden_bytecode {
                    // SAFETY: trusted, per the option's contract.
                    Some(bytecode) => unsafe { sandbox::harden_from(&cx, bytecode)? },
                    None => sandbox::harden(&cx)?,
                }
            }
            Ok(())
        })
        .map_err(|e| cx.with(|cx| JsError::from_engine(&cx, e)))?;
        Ok(Host {
            cx,
            rt: RefCell::new(Some(rt)),
            scheduler,
            exhausted,
            shared,
            on_error: None,
            on_rejection: None,
            budget,
            evaluations: RefCell::new(Vec::new()),
            entry_depth: Cell::new(0),
        })
    }

    /// Aborts running JS (with an uncatchable exception) once `stop` is
    /// set: an engine shutting down never waits for a long-running script.
    pub fn set_stop_flag(&self, stop: std::sync::Arc<std::sync::atomic::AtomicBool>) {
        if let Some(rt) = self.rt.borrow().as_ref() {
            self.scheduler
                .ready(rt.set_interrupt_handler(Some(self.budget.interrupt_handler(Some(stop)))));
        }
    }

    /// Why the VM was stopped, if it was: it ran out of memory, or the app
    /// went over a quota. No JS runs after that; the views stay as they are.
    pub fn fatal(&self) -> Option<String> {
        self.shared.fatal.borrow().clone()
    }

    /// Stops the VM (e.g. the core refused an op over a quota).
    pub fn stop(&self, reason: String) {
        self.shared.stop(reason);
        if self.entry_depth.get() == 0 {
            self.stop_work();
        }
    }

    /// The VM's limits.
    pub fn limits(&self) -> &Limits {
        self.budget.limits()
    }

    /// Runs `f` (a call into JS) within the budget of `phase`; `None` once
    /// the VM was stopped.
    fn guarded<R>(&self, phase: Phase, f: impl FnOnce() -> R) -> Option<R> {
        if self.shared.fatal.borrow().is_some() {
            if self.entry_depth.get() == 0 {
                self.stop_work();
            }
            return None;
        }
        self.entry_depth.set(self.entry_depth.get() + 1);
        let running = self.budget.run(phase);
        let result = f();
        drop(running);
        // The app may have caught running out (it is an `InternalError`):
        // the VM stops all the same.
        if self.exhausted.load(Ordering::Relaxed) && self.shared.fatal.borrow().is_none() {
            self.uncaught(&JsError::new("out of memory".to_owned()));
        }
        self.entry_depth.set(self.entry_depth.get() - 1);
        if self.entry_depth.get() == 0 && self.fatal().is_some() {
            self.stop_work();
        }
        Some(result)
    }

    /// Retire native work and JS together while retaining the core's rendered
    /// snapshot and already queued operations. Never called under a JS entry.
    fn stop_work(&self) {
        self.scheduler.disable();
        self.shared.system_wake.borrow_mut().take();
        self.shared.system_exit_handler.borrow_mut().take();
        self.evaluations.borrow_mut().clear();
        self.shared.timers.borrow_mut().clear();
        self.shared.frames.borrow_mut().clear();
        if self.cx.is_live() {
            self.cx.with(|cx| crate::state::uninstall(&cx));
            self.cx.retire();
        }
        // After the state, whose freeing may reject what waits on it;
        // the rejections' values go before the runtime.
        if let Some(rt) = self.rt.borrow().as_ref() {
            self.scheduler
                .ready(rt.set_host_promise_rejection_tracker(None));
        }
        self.shared.rejections.borrow_mut().clear();
        self.rt.borrow_mut().take();
    }

    /// What an error from a call means: an overrun budget or exhausted
    /// memory get a message saying so (exhausted memory also stops the VM).
    fn classify(&self, mut err: JsError) -> JsError {
        if let Some(trip) = self.budget.take_trip() {
            err.message = format!("{trip}\n{}", err.message);
        } else if self.exhausted.load(Ordering::Relaxed) {
            let reason = format!(
                "the script ran out of memory (the JS heap is limited to {} MB) and was stopped. \
                 Keep large data out of JS: load it in pages, or keep it on the native side \
                 (a server, a native module) and hand JS only what it shows.",
                self.budget.limits().memory_bytes >> 20
            );
            self.shared.stop(reason.clone());
            err.message = format!("{reason}\n{}", err.message);
        }
        err
    }

    /// The error for a call refused because the VM was stopped.
    fn stopped(&self) -> JsError {
        JsError::new(self.fatal().unwrap_or_default())
    }

    /// Sets what canvas `measureText` measures with.
    pub fn set_text_measurer(&mut self, measurer: TextMeasurer) {
        *self.shared.measurer.borrow_mut() = Some(measurer);
    }

    /// Sets the handler for uncaught exceptions (in event handlers, timers and
    /// promise jobs). Without a handler they are logged.
    pub fn set_error_handler(&mut self, handler: ErrorHandler) {
        self.on_error = Some(handler);
    }

    /// Actual native module exports for declaration generation. This evaluates
    /// trusted module initializers only, without running user bundles or jobs.
    #[cfg(not(feature = "bytecode-only"))]
    pub(crate) fn standard_exports(&self) -> Result<Vec<(String, Vec<String>)>, JsError> {
        self.guarded(Phase::Load, || {
            self.cx
                .with(|cx| {
                    crate::standard::NAMES
                        .iter()
                        .map(|name| {
                            let module = crate::modules::load_module(&cx, name)
                                .catch(&cx)
                                .map_err(JsError::caught)?;
                            let (module, promise) =
                                module.eval().catch(&cx).map_err(JsError::caught)?;
                            if let Some(result) = promise.result::<()>() {
                                result.catch(&cx).map_err(JsError::caught)?;
                            }
                            let namespace =
                                module.namespace().catch(&cx).map_err(JsError::caught)?;
                            let mut exports = namespace
                                .keys::<String>()
                                .collect::<rquickjs::Result<Vec<_>>>()
                                .catch(&cx)
                                .map_err(JsError::caught)?;
                            exports.sort();
                            Ok(((*name).to_owned(), exports))
                        })
                        .collect::<Result<Vec<(String, Vec<String>)>, JsError>>()
                })
                .map_err(|error| self.classify(error))
        })
        .unwrap_or_else(|| Err(self.stopped()))
    }

    #[cfg(feature = "bytecode-only")]
    pub(crate) fn standard_exports(&self) -> Result<Vec<(String, Vec<String>)>, JsError> {
        Ok(Vec::new())
    }

    /// Sets the handler for unhandled promise rejections: promises still
    /// rejected without a handler once a turn's jobs ran (as browsers
    /// report them). Without a handler they are logged (target `js`, level
    /// error), as `unhandled rejection: <reason>`.
    pub fn set_rejection_handler(&mut self, handler: ErrorHandler) {
        self.on_rejection = Some(handler);
    }

    /// Evaluates a bundle given as source.
    pub fn eval_source(&self, source: &str) -> Result<(), JsError> {
        self.guarded(Phase::Load, || {
            let promise = self
                .cx
                .with(|cx| -> Result<_, JsError> {
                    let module = Module::declare(cx.clone(), crate::BUNDLE_NAME, source)
                        .catch(&cx)
                        .map_err(JsError::caught)?;
                    let (_, promise) = module.eval().catch(&cx).map_err(JsError::caught)?;
                    // Its failure is the bundle's, reported as such.
                    mark_handled(&cx, &promise);
                    Ok(Persistent::save(&cx, promise))
                })
                .map_err(|e| self.classify(e))?;
            self.finish_evaluation(promise)
        })
        .unwrap_or_else(|| Err(self.stopped()))
    }

    /// Poll native work outside the context lock. A module awaiting I/O remains
    /// owned by the VM and resumes on its engine wake, without blocking input.
    fn finish_evaluation(&self, promise: Persistent<Promise<'static>>) -> Result<(), JsError> {
        self.run_jobs();
        let result = self.cx.with(|cx| {
            let restored = promise
                .clone()
                .restore(&cx)
                .map_err(|e| JsError::from_engine(&cx, e))?;
            Ok::<_, JsError>(
                restored
                    .result::<()>()
                    .map(|r| r.catch(&cx).map_err(JsError::caught)),
            )
        })?;
        match result {
            Some(result) => result.map_err(|e| self.classify(e)),
            None => {
                self.evaluations.borrow_mut().push(promise);
                Ok(())
            }
        }
    }

    fn settle_evaluations(&self) {
        let pending = self.evaluations.take();
        for promise in pending {
            let result = self.cx.with(|cx| match promise.clone().restore(&cx) {
                Ok(promise) => promise
                    .result::<()>()
                    .map(|r| r.catch(&cx).map_err(JsError::caught)),
                Err(error) => Some(Err(JsError::from_engine(&cx, error))),
            });
            match result {
                Some(Err(error)) => self.uncaught(&error),
                Some(Ok(())) => {}
                None => self.evaluations.borrow_mut().push(promise),
            }
        }
    }

    /// Evaluates a classic script named `name` (for stack traces) and
    /// returns whether its completion value is `true`: development updates
    /// report whether they could be applied.
    pub fn eval_script(&self, name: &str, source: &str) -> Result<bool, JsError> {
        self.guarded(Phase::Load, || self.eval_script_unguarded(name, source))
            .unwrap_or_else(|| Err(self.stopped()))
    }

    fn eval_script_unguarded(&self, name: &str, source: &str) -> Result<bool, JsError> {
        let applied = self.cx.with(|cx| -> Result<bool, JsError> {
            let mut options = rquickjs::context::EvalOptions::default();
            options.global = true;
            options.strict = false;
            options.filename = Some(name.to_owned());
            let value: rquickjs::Value<'_> = cx
                .eval_with_options(source, options)
                .catch(&cx)
                .map_err(JsError::caught)?;
            Ok(value.as_bool() == Some(true))
        });
        let applied = applied.map_err(|e| self.classify(e))?;
        self.run_jobs();
        Ok(applied)
    }

    /// Evaluates a bundle compiled with [`crate::compile_bytecode`].
    pub fn eval_bytecode(&self, bytecode: &[u8]) -> Result<(), JsError> {
        self.guarded(Phase::Load, || {
            let promise = self
                .cx
                .with(|cx| -> Result<_, JsError> {
                    // SAFETY: bytecode comes from `compile_bytecode` with the same
                    // QuickJS build; QuickJS does not validate arbitrary input.
                    let module = unsafe { Module::load(cx.clone(), bytecode) }
                        .catch(&cx)
                        .map_err(JsError::caught)?;
                    let (_, promise) = module.eval().catch(&cx).map_err(JsError::caught)?;
                    // Its failure is the bundle's, reported as such.
                    mark_handled(&cx, &promise);
                    Ok(Persistent::save(&cx, promise))
                })
                .map_err(|e| self.classify(e))?;
            self.finish_evaluation(promise)
        })
        .unwrap_or_else(|| Err(self.stopped()))
    }

    /// Gives the VM chunk `id` of a split bundle (an ES module as
    /// `nsh-bundler` makes it), before the bundle is evaluated or when it
    /// was asked for ([`Host::take_chunk_requests`]); the imports waiting
    /// for it continue.
    pub fn add_chunk_source(&self, id: &str, source: String) {
        self.add_chunk(id, crate::modules::ChunkCode::Source(source));
    }

    /// [`Host::add_chunk_source`] for a chunk compiled with
    /// [`crate::compile_chunk_bytecode`].
    ///
    /// # Safety
    ///
    /// As [`Host::eval_bytecode`]: bytecode from this QuickJS build, from a
    /// trusted source (QuickJS does not validate it).
    pub unsafe fn add_chunk_bytecode(&self, id: &str, bytecode: Vec<u8>) {
        self.add_chunk(id, crate::modules::ChunkCode::Bytecode(bytecode));
    }

    fn add_chunk(&self, id: &str, code: crate::modules::ChunkCode) {
        self.guarded(Phase::Call, || {
            self.cx
                .with(|cx| crate::chunks::add(cx.as_raw().as_ptr(), id, code));
            self.run_jobs();
        });
    }

    /// Chunk `id` could not be loaded: the imports waiting for it reject
    /// with `message`. A later import asks for it again.
    pub fn chunk_failed(&self, id: &str, message: &str) {
        self.guarded(Phase::Call, || {
            self.cx
                .with(|cx| crate::chunks::failed(cx.as_raw().as_ptr(), id, message));
            self.run_jobs();
        });
    }

    /// Moves the ids of the chunks the app imports and the VM does not have
    /// (since the last call) into `out`: the host loads each and hands it
    /// over with [`Host::add_chunk_source`] or [`Host::chunk_failed`].
    pub fn take_chunk_requests(&self, out: &mut Vec<String>) {
        if !self.cx.is_live() {
            return;
        }
        self.cx.with(|cx| {
            // SAFETY: the context's state, for this call.
            unsafe { &(*crate::state::state(cx.as_raw().as_ptr())).chunks }.take_requests(out)
        });
    }

    /// Delivers what the core hands JS after a commit
    /// ([`nsh_core::Core::take_events`]): a node's event to its handler, a
    /// Rust component's event to its `on<Event>` prop, a call's result to
    /// its promise (converted now).
    pub fn deliver(&self, event: nsh_core::ui::JsEvent) {
        if let nsh_core::ui::JsEvent::Event(id, kind, payload) = &event {
            self.dispatch_event(*id, *kind, payload);
            return;
        }
        // What it carries is the app's (a result, an event): dropped
        // unused (JS stopped), its `Drop` must not unwind into the engine.
        let delivered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.guarded(Phase::Call, || {
                self.cx.with(|cx| {
                    let raw = cx.as_raw().as_ptr();
                    if crate::components::deliver(raw, event).is_err() {
                        self.report::<()>(&cx, Err(rquickjs::Error::Exception));
                    }
                });
                self.run_jobs();
            })
        }));
        if delivered.is_err() {
            log::error!(target: "js", "a value for JS panicked as it dropped");
        }
    }

    /// Collects existing contacts whose owner no longer accepts native input,
    /// without entering application code or running jobs.
    pub fn invalid_touch_contacts(
        &self,
        accepts: impl FnMut(NodeId) -> bool,
        contacts: &mut Vec<u32>,
    ) {
        if !self.cx.is_live() {
            return;
        }
        self.cx
            .with(|cx| crate::touch::invalid_contacts(cx.as_raw().as_ptr(), accepts, contacts));
    }

    /// Forgets a physically cancelled native contact without handlers or jobs.
    /// The last known contact releases the JS responder and native scroll block;
    /// cancelling an unknown contact is inert, including repeated cancellation.
    pub fn cancel_touch(&self, contact: u32) {
        if !self.cx.is_live() {
            return;
        }
        if self
            .cx
            .with(|cx| crate::touch::cancel_touch(cx.as_raw().as_ptr(), contact))
        {
            // Trusted native cleanup remains possible when the app filled its
            // own op quota. It creates no JS values and never enters app code.
            self.shared.ops.borrow_mut().push(Op::Command {
                id: nsh_core::ROOT_ID,
                command: nsh_core::Command::ClearJsResponder,
            });
        }
    }

    /// Delivers a native event (and its data) to the node's JS handler.
    pub fn dispatch_event(&self, id: NodeId, event: EventKind, payload: &EventPayload) {
        self.guarded(Phase::Call, || {
            self.cx.with(|cx| {
                // Touches: the responder system is native.
                if let (EventKind::Touch, EventPayload::Touch(touch)) = (event, payload) {
                    if crate::touch::dispatch(cx.as_raw().as_ptr(), touch).is_err() {
                        self.report::<()>(&cx, Err(rquickjs::Error::Exception));
                    }
                    return;
                }
                let payload = match (event, payload) {
                    // `onChange` receives the text itself, as in React Native.
                    (EventKind::ChangeText, EventPayload::Text { text, .. }) => {
                        rquickjs::String::from_str(cx.clone(), text).map(|s| s.into_value())
                    }
                    (_, EventPayload::Value(value)) => payload_value(&cx, value),
                    // A video's `onLoad`: `{ duration, size }` of the
                    // platforms' `duration`, `width` and `height`.
                    (EventKind::Load, EventPayload::Map(fields))
                        if fields.iter().any(|(k, _)| *k == "duration") =>
                    {
                        video_load(&cx, fields)
                    }
                    _ => payload_object(&cx, payload),
                };
                let raw = cx.as_raw().as_ptr();
                let result = payload.and_then(|payload| {
                    // Nodes hold their handlers natively.
                    let Some(handler) = crate::dom::handler(raw, id, event) else {
                        return Ok(());
                    };
                    // SAFETY: an owned function value of this context.
                    let handler = unsafe { Value::from_raw(cx.clone(), handler) };
                    match handler.into_function() {
                        Some(f) => f.call::<_, ()>((payload,)),
                        None => Ok(()),
                    }
                });
                // A listener made under an error boundary fails into it.
                let result = match result {
                    Err(rquickjs::Error::Exception)
                        if crate::dom::catch_listener_failure(raw, id) =>
                    {
                        Ok(())
                    }
                    other => other,
                };
                self.report(&cx, result);
            });
            self.run_jobs();
        });
    }

    /// Asks a `List` to render items into cells: `(slot, item index)`
    /// pairs.
    pub fn bind_list(&self, list: NodeId, binds: &[(u32, u32)]) {
        self.guarded(Phase::Call, || {
            self.cx.with(|cx| {
                if let Some(Err(_)) = crate::list::bind(cx.as_raw().as_ptr(), list, binds) {
                    self.report::<()>(&cx, Err(rquickjs::Error::Exception));
                }
            });
            self.run_jobs();
        });
    }

    /// Resolves the promises of finished (or interrupted) native animations.
    pub fn animations_finished(&self, finished: &[nsh_core::animation::Finished]) {
        self.guarded(Phase::Call, || {
            if finished.is_empty() {
                return;
            }
            self.cx.with(|cx| {
                let raw = cx.as_raw().as_ptr();
                for f in finished {
                    if crate::animated::finished(raw, f).is_err() {
                        self.report::<()>(&cx, Err(rquickjs::Error::Exception));
                    }
                }
            });
            self.run_jobs();
        });
    }

    /// Moves the ops committed by JS since the last call into `out`.
    pub fn take_ops(&self, out: &mut Vec<Op>) {
        if self.cx.is_live() {
            self.cx.with(|cx| {
                let raw = cx.as_raw().as_ptr();
                // SAFETY: this host owns the registered context state.
                unsafe { (*crate::state::state(raw)).lists.publish_sources(raw) };
            });
        }
        let mut ops = self.shared.ops.borrow_mut();
        if out.is_empty() {
            std::mem::swap(out, &mut ops);
        } else {
            out.append(&mut ops);
        }
        drop(ops);
        let mut releases = self.shared.releases.borrow_mut();
        out.extend(releases.drain(..).map(|id| Op::Release { id }));
        drop(releases);
        out.extend(
            self.shared
                .animation_releases
                .borrow_mut()
                .drain(..)
                .map(Op::Animation),
        );
    }

    /// Sets native system permissions and the app-specific trusted data directory.
    /// Process and file access require explicit grants, including in standalone apps.
    pub fn set_system_access(
        &self,
        access: nsh_core::access::Access,
        data_dir: Option<std::path::PathBuf>,
    ) {
        *self.shared.system_access.borrow_mut() = access;
        *self.shared.system_data_dir.borrow_mut() = data_dir;
    }

    /// Sets trusted application and home directory anchors for manifest grants.
    pub fn set_system_paths(&self, paths: nsh_core::access::TrustedPaths) {
        *self.shared.system_paths.borrow_mut() = paths;
    }

    /// Installs an app-private virtual filesystem. Capability checks stay in Rust.
    pub fn set_filesystem(
        &self,
        filesystem: Option<std::sync::Arc<dyn nsh_core::filesystem::FileSystem>>,
    ) {
        *self.shared.system_filesystem.borrow_mut() = filesystem;
    }

    /// Installs the host WebSocket transport.
    pub fn set_websocket_transport(
        &self,
        transport: Option<std::sync::Arc<dyn nsh_core::websocket::WebSocketTransport>>,
    ) {
        *self.shared.system_websocket.borrow_mut() = transport;
    }

    /// Connects `nsh/host` to the embedding app: its launch parameters, and
    /// where the app's calls and posts go. Call before evaluating the bundle
    /// (`host.params` is read when the module is first imported).
    pub fn set_host_bridge(&self, bridge: Rc<dyn nsh_core::host_channel::HostBridge>) {
        *self.shared.host_bridge.borrow_mut() = Some(bridge);
    }

    /// Delivers the embedding app's event `name` (`host.on`): to the
    /// listeners of its name, or kept until one is added.
    pub fn host_event(&self, name: &str, data: nsh_core::JsonValue) {
        if !self.cx.is_live() {
            return;
        }
        self.guarded(Phase::Call, || {
            self.cx.with(|cx| {
                crate::host_channel::deliver(cx.as_raw().as_ptr(), name, data);
            });
            self.run_jobs();
        });
    }

    /// Settles call `id` (`host.call`) with the embedding app's answer, or
    /// rejects it with the message.
    pub fn host_reply(&self, id: u64, result: Result<nsh_core::JsonValue, String>) {
        if !self.cx.is_live() {
            return;
        }
        self.guarded(Phase::Call, || {
            self.cx.with(|cx| {
                crate::host_channel::settle(cx.as_raw().as_ptr(), id, result);
            });
            self.run_jobs();
        });
    }

    /// Installs the meaning of `process.exit(code)` for this VM. The callback
    /// runs on the owning engine thread after the app's exit capability check.
    /// NSH never terminates the embedding process itself.
    pub fn set_exit_handler(&self, handler: Rc<dyn Fn(i32)>) {
        if self.fatal().is_some() {
            return;
        }
        *self.shared.system_exit_handler.borrow_mut() = Some(handler);
    }

    /// Wakes this host's engine when a process worker produces an event.
    pub fn set_system_wake(&self, wake: Arc<dyn Fn() + Send + Sync>) {
        if self.fatal().is_some() {
            return;
        }
        self.scheduler.set_wake(wake.clone());
        *self.shared.system_wake.borrow_mut() = Some(wake);
    }

    /// Drains pending promise jobs (the runtime modules' work runs as core
    /// tasks, whose results arrive through the core).
    pub fn run_system(&self) {
        self.guarded(Phase::Call, || self.run_jobs());
    }

    /// Whether JS work is still pending in this VM: evaluations, timers or
    /// jobs. Workers wake the engine; this predicate does not schedule
    /// polling.
    pub fn has_system_tasks(&self) -> bool {
        if self.fatal().is_some() {
            return false;
        }
        !self.evaluations.borrow().is_empty()
            || self
                .scheduler
                .ready(self.rt.borrow().as_ref().expect("live VM").is_job_pending())
    }

    /// Earliest timer deadline, if any timer is pending.
    pub fn next_timer(&self) -> Option<Instant> {
        let timer = self.shared.timers.borrow_mut().next_deadline();
        let host = self
            .cx
            .is_live()
            .then(|| {
                self.cx
                    .with(|cx| crate::host_channel::next_deadline(cx.as_raw().as_ptr()))
            })
            .flatten();
        timer.into_iter().chain(host).min()
    }

    /// Runs all timers due at `now`.
    pub fn run_timers(&self, now: Instant) {
        if self.cx.is_live() {
            self.guarded(Phase::Call, || {
                self.cx
                    .with(|cx| crate::host_channel::expire(cx.as_raw().as_ptr(), now));
                self.run_jobs();
            });
        }
        loop {
            // Release the borrow before calling into JS: callbacks may add timers.
            let Some(callback) = self.shared.timers.borrow_mut().pop_due(now) else {
                break;
            };
            // Each callback, with the microtasks it queues, has a budget of its own.
            let ran = self.guarded(Phase::Call, || {
                self.cx.with(|cx| {
                    let result = callback.restore(&cx).and_then(|f| f.call::<_, ()>(()));
                    self.report(&cx, result);
                });
                self.run_jobs();
            });
            if ran.is_none() {
                break;
            }
        }
    }

    /// Runs pending promise jobs and microtasks until the queue is empty,
    /// then reports the promises rejected meanwhile that are still without
    /// a handler ([`Host::set_rejection_handler`]). Every call from Rust
    /// into JS ends with it: it is the end of the turn.
    pub fn run_jobs(&self) {
        self.guarded(Phase::Call, || {
            loop {
                loop {
                    match self
                        .scheduler
                        .poll_job(self.rt.borrow().as_ref().expect("live VM"))
                    {
                        std::task::Poll::Ready(Ok(true)) => {}
                        std::task::Poll::Ready(Ok(false)) | std::task::Poll::Pending => break,
                        std::task::Poll::Ready(Err(err)) => {
                            let err = self.scheduler.ready(err.with(|cx| {
                                let caught = cx.catch();
                                let mut err = JsError::new(describe(caught.clone()));
                                err.null = caught.is_null();
                                err
                            }));
                            self.uncaught(&err);
                            if self.fatal().is_some() {
                                break;
                            }
                        }
                    }
                }
                if self.fatal().is_some() {
                    break;
                }
                self.settle_evaluations();
                // Rendering a reason may run JS (a getter) and queue jobs.
                if !self.report_rejections() {
                    break;
                }
            }
        });
    }

    /// Reports the rejections still unhandled; whether there were any.
    fn report_rejections(&self) -> bool {
        // Taken first: rendering a reason may run JS, which may reject.
        let rejections = self.shared.rejections.borrow_mut().take();
        if rejections.is_empty() {
            return false;
        }
        // A VM out of memory stops with that report; what failed for it is
        // not the app's to handle.
        if self.exhausted.load(Ordering::Relaxed) || self.shared.fatal.borrow().is_some() {
            return false;
        }
        self.cx.with(|cx| {
            for rejection in rejections {
                let mut text = String::new();
                if let Ok(reason) = rejection.reason(&cx) {
                    console::format_value(&reason, &mut text);
                }
                // An error without a stack ends with its empty line.
                text.truncate(text.trim_end().len());
                let err = JsError::new(text);
                match &self.on_rejection {
                    Some(handler) => handler(&err),
                    None => log::error!(target: "js", "unhandled rejection: {err}"),
                }
            }
        });
        true
    }

    /// How many rejections wait for the end of the turn (tests).
    #[cfg(test)]
    pub(crate) fn pending_rejections(&self) -> usize {
        self.shared.rejections.borrow().len()
    }

    /// Whether warning `message` was logged (tests).
    #[cfg(test)]
    pub(crate) fn warned(&self, message: &str) -> bool {
        self.shared.warnings.borrow().reported(message)
    }

    /// Runs `f` with the raw context (tests).
    #[cfg(test)]
    pub(crate) fn with_raw<R>(&self, f: impl FnOnce(*mut qjs::JSContext) -> R) -> R {
        self.cx.with(|cx| f(cx.as_raw().as_ptr()))
    }

    /// Whether an exception is pending outside any call (none should be).
    #[cfg(test)]
    pub(crate) fn has_exception(&self) -> bool {
        if !self.cx.is_live() {
            return false;
        }
        // SAFETY: a check on the live context.
        self.cx
            .with(|cx| unsafe { qjs::JS_HasException(cx.as_raw().as_ptr()) })
    }

    /// Runs the calls of JS functions Rust queued (`Callback::post`,
    /// `Callback::call_async`), in order; those queued meanwhile wait for
    /// the next call. The engine calls it each turn, after the core's work.
    pub fn run_posted(&self) {
        if self.fatal().is_some() {
            // Stopped for good: what waits for these calls is told so.
            if self.cx.is_live() {
                self.cx
                    .with(|cx| crate::classes::close(cx.as_raw().as_ptr()));
            }
            return;
        }
        self.guarded(Phase::Call, || {
            self.cx.with(|cx| {
                let ran = crate::classes::run_posted(cx.as_raw().as_ptr());
                self.report(&cx, ran.map_err(|_| rquickjs::Error::Exception));
            });
            self.run_jobs();
        });
    }

    /// Releases the posts JS's ops park (as the core does) and runs the
    /// posted calls: for tests without a core.
    #[cfg(test)]
    pub(crate) fn run_posted_without_core(&self) {
        let mut ops = Vec::new();
        self.take_ops(&mut ops);
        self.apply_posts(&mut ops);
        self.run_posted();
    }

    /// Applies the posts' ops among `ops` (as the core does: dropped, they
    /// release their places): for tests without a core.
    #[cfg(test)]
    pub(crate) fn apply_posts(&self, ops: &mut Vec<Op>) {
        ops.retain(|op| {
            !matches!(
                op,
                Op::Rust(nsh_core::ui::RustOp {
                    run: nsh_core::ui::RustCall::Post(_),
                    ..
                })
            )
        });
    }

    /// Whether calls Rust queued wait for [`Host::run_posted`].
    pub fn has_posted(&self) -> bool {
        if !self.cx.is_live() {
            return false;
        }
        self.cx
            .with(|cx| crate::classes::has_posted(cx.as_raw().as_ptr()))
    }

    /// Moves the network requests and cancellations made since the last
    /// call into `out`.
    pub fn take_network(&self, out: &mut NetworkQueue) {
        if self.cx.is_live() && !self.shared.dropped_fetches.borrow().is_empty() {
            self.cx
                .with(|cx| crate::web::forget_dropped_fetches(cx.as_raw().as_ptr()));
        }
        out.ops.append(&mut self.shared.net.borrow_mut().ops);
    }

    /// Replaces the host's native focus path without running JS jobs,
    /// reactive effects, event handlers or timers. Hosts report it before
    /// delivering input or an environment change that may read the snapshot.
    pub fn set_focus_path(&self, path: &[NodeId]) {
        if self.cx.is_live() {
            self.cx
                .with(|cx| crate::keymap::set_focus_path(cx.as_raw().as_ptr(), path));
        }
    }

    /// Publishes the surface's environment to JS. Call once before
    /// evaluating the bundle (the runtime reads the initial value), then on
    /// every change.
    pub fn set_environment(&self, env: &Environment) {
        self.guarded(Phase::Call, || {
            self.cx.with(|cx| {
                let result = (|| {
                    let raw = cx.as_raw().as_ptr();
                    // SAFETY: the state of this host's context.
                    unsafe { &(*crate::state::state(raw)).dom }.set_platform(env.os, env.desktop());
                    if crate::env::set_environment(raw, env).is_err() {
                        return Err(rquickjs::Error::Exception);
                    }
                    Ok(())
                })();
                self.report(&cx, result);
            });
            self.run_jobs();
        });
    }

    /// Publishes the design tokens the app is drawn with to JS (`token()`
    /// of `nsh`). Call before evaluating the bundle, then on every change.
    pub fn set_tokens(&self, tokens: std::sync::Arc<nsh_core::ui::Tokens>) {
        self.guarded(Phase::Call, || {
            self.cx.with(|cx| {
                crate::env::set_tokens(cx.as_raw().as_ptr(), tokens);
            });
            self.run_jobs();
        });
    }

    /// True if JS asked for a display frame (`requestAnimationFrame`).
    pub fn wants_frame(&self) -> bool {
        !self.shared.frames.borrow().is_empty()
    }

    /// Runs the `requestAnimationFrame` callbacks queued so far, with the
    /// current `performance.now()`. Callbacks requested meanwhile wait for
    /// the next frame.
    pub fn run_frame(&self) {
        self.guarded(Phase::Call, || {
            let callbacks = std::mem::take(&mut *self.shared.frames.borrow_mut());
            if callbacks.is_empty() {
                return;
            }
            self.cx.with(|cx| {
                let now = (|| -> rquickjs::Result<f64> {
                    let performance: rquickjs::Object = cx.globals().get("performance")?;
                    performance.get::<_, Function>("now")?.call(())
                })()
                .unwrap_or(0.0);
                for (_, callback) in callbacks {
                    let result = callback.restore(&cx).and_then(|f| f.call::<_, ()>((now,)));
                    self.report(&cx, result);
                }
            });
            self.run_jobs();
        });
    }

    /// Moves the font assets (`asset:/…` URIs) imported since the last call
    /// into `out`. They must be registered before the next layout.
    pub fn take_fonts(&self, out: &mut Vec<String>) {
        out.append(&mut self.shared.fonts.borrow_mut());
    }

    /// Delivers an event of request `id` (what the network stack reported).
    pub fn fetch_event(&self, id: RequestId, event: FetchEvent) {
        self.guarded(Phase::Call, || {
            self.cx.with(|cx| {
                let raw = cx.as_raw().as_ptr();
                let result =
                    crate::web::fetch_event(raw, id, event).map_err(|_| rquickjs::Error::Exception);
                self.report(&cx, result);
            });
            self.run_jobs();
        });
    }

    /// The number of live JS objects (diagnostics: leak checks).
    pub fn object_count(&self) -> i64 {
        self.rt
            .borrow()
            .as_ref()
            .map_or(0, |rt| self.scheduler.ready(rt.memory_usage()).obj_count)
    }

    /// Runs the cycle collector. Call when idle so released nodes are
    /// reported promptly.
    pub fn collect_garbage(&self) {
        self.guarded(Phase::Call, || {
            self.scheduler
                .ready(self.rt.borrow().as_ref().expect("live VM").run_gc());
            self.run_jobs();
        });
    }
}

impl Host {
    fn report<T>(&self, cx: &Ctx<'_>, result: rquickjs::Result<T>) {
        if let Err(err) = result.catch(cx) {
            self.uncaught(&JsError::caught(err));
        }
    }

    fn uncaught(&self, err: &JsError) {
        let err = self.classify(err.clone());
        match &self.on_error {
            Some(handler) => handler(&err),
            None => log::error!(target: "js", "uncaught exception: {err}"),
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stop_work();
    }
}

/// Marks `promise` handled: it is not reported as an unhandled rejection.
fn mark_handled(cx: &Ctx<'_>, promise: &rquickjs::Promise<'_>) {
    // SAFETY: a live promise of this context.
    unsafe { qjs::JS_PromiseMarkAsHandled(cx.as_raw().as_ptr(), promise.as_raw()) };
}

/// A video's `onLoad` payload: `{ duration, size: { width, height } }`.
fn video_load<'js>(
    cx: &Ctx<'js>,
    fields: &[(&'static str, PayloadValue)],
) -> rquickjs::Result<Value<'js>> {
    let obj = rquickjs::Object::new(cx.clone())?;
    let size = rquickjs::Object::new(cx.clone())?;
    for (key, value) in fields {
        match *key {
            "width" | "height" => size.set(*key, payload_value(cx, value)?)?,
            _ => obj.set(*key, payload_value(cx, value)?)?,
        }
    }
    obj.set("size", size)?;
    Ok(obj.into_value())
}

/// The JS object handed to event handlers.
fn payload_object<'js>(cx: &Ctx<'js>, payload: &EventPayload) -> rquickjs::Result<Value<'js>> {
    let obj = rquickjs::Object::new(cx.clone())?;
    match payload {
        EventPayload::None => return Ok(Value::new_undefined(cx.clone())),
        EventPayload::Value(value) => return payload_value(cx, value),
        EventPayload::Map(fields) => {
            for (key, value) in fields {
                obj.set(*key, payload_value(cx, value)?)?;
            }
        }
        EventPayload::Press(nsh_core::PressEvent {
            position,
            page_position,
            modifiers,
            clicks,
        }) => {
            obj.set("position", point_object(cx, *position)?)?;
            obj.set("pagePosition", point_object(cx, *page_position)?)?;
            obj.set("modifiers", modifiers_object(cx, modifiers)?)?;
            obj.set("clickCount", *clicks)?;
        }
        EventPayload::Hover(nsh_core::HoverEvent {
            position,
            page_position,
            modifiers,
        })
        | EventPayload::ContextMenu(nsh_core::ContextMenuEvent {
            position,
            page_position,
            modifiers,
        }) => {
            obj.set("position", point_object(cx, *position)?)?;
            obj.set("pagePosition", point_object(cx, *page_position)?)?;
            obj.set("modifiers", modifiers_object(cx, modifiers)?)?;
        }
        EventPayload::FileDrop(uris) => {
            let list = rquickjs::Array::new(cx.clone())?;
            for (index, uri) in uris.iter().enumerate() {
                list.set(index, uri.as_str())?;
            }
            obj.set("uris", list)?;
        }
        // The bytes cross natively: each file is a `File` over them.
        EventPayload::Paste(paste) => {
            obj.set("text", paste.text.as_str())?;
            let files = rquickjs::Array::new(cx.clone())?;
            for (index, file) in paste.files.iter().enumerate() {
                let blob = crate::web::blob::Blob::new(file.data.clone(), file.mime.clone());
                let made = crate::web::blob::new_file(
                    cx.as_raw().as_ptr(),
                    blob,
                    file.name.clone(),
                    crate::web::blob::now_ms(),
                )
                .map_err(|_| rquickjs::Error::Exception)?;
                // SAFETY: an owned value of this context, handed over.
                let value = unsafe { Value::from_raw(cx.clone(), made.take()) };
                files.set(index, value)?;
            }
            obj.set("files", files)?;
            let uris = rquickjs::Array::new(cx.clone())?;
            for (index, uri) in paste.uris.iter().enumerate() {
                uris.set(index, uri.as_str())?;
            }
            obj.set("uris", uris)?;
        }
        // The core answers picks; JS never gets their files this way.
        EventPayload::Picked { id, .. } => obj.set("id", *id)?,
        EventPayload::Native { name, data } => {
            obj.set("name", &**name)?;
            obj.set("data", json_value(cx, data)?)?;
        }
        EventPayload::Json(value) => return json_value(cx, value),
        EventPayload::TextLayout(lines) => {
            let list = rquickjs::Array::new(cx.clone())?;
            for (i, l) in lines.iter().enumerate() {
                let line = rquickjs::Object::new(cx.clone())?;
                line.set("text", l.text.as_str())?;
                let bounds = nsh_core::geometry::Bounds {
                    origin: nsh_core::geometry::point(l.x, l.y),
                    size: nsh_core::geometry::Size::new(l.width, l.height),
                };
                line.set("bounds", bounds_object(cx, bounds)?)?;
                line.set("ascender", l.ascender.0)?;
                line.set("descender", l.descender.0)?;
                line.set("capHeight", l.cap_height.0)?;
                line.set("xHeight", l.x_height.0)?;
                list.set(i, line)?;
            }
            obj.set("lines", list)?;
        }
        EventPayload::Layout(frame) => return Ok(bounds_object(cx, *frame)?.into_value()),
        EventPayload::Pan {
            translation,
            velocity_x,
            velocity_y,
            value_x,
            value_y,
        }
        | EventPayload::PanCancelled {
            translation,
            velocity_x,
            velocity_y,
            value_x,
            value_y,
        } => {
            obj.set(
                "cancelled",
                matches!(payload, EventPayload::PanCancelled { .. }),
            )?;
            obj.set("translationX", translation.x.0)?;
            obj.set("translationY", translation.y.0)?;
            obj.set("velocityX", *velocity_x)?;
            obj.set("velocityY", *velocity_y)?;
            if let Some(v) = value_x {
                obj.set("valueX", v.0)?;
            }
            if let Some(v) = value_y {
                obj.set("valueY", v.0)?;
            }
        }
        EventPayload::Scroll(offset) => {
            obj.set("x", offset.x.0)?;
            obj.set("y", offset.y.0)?;
        }
        // The numbers JS always got (pixels are whole).
        EventPayload::Image(size) => {
            obj.set("width", size.width.0 as f32)?;
            obj.set("height", size.height.0 as f32)?;
        }
        EventPayload::Error { message } => obj.set("message", message.as_str())?,
        EventPayload::Text { text, .. } => obj.set("text", text.as_str())?,
        EventPayload::Touch(touch) => {
            obj.set(
                "phase",
                match touch.phase {
                    TouchPhase::Start => "start",
                    TouchPhase::Move => "move",
                    TouchPhase::End => "end",
                    TouchPhase::Cancel => "cancel",
                },
            )?;
            obj.set("timestamp", touch.timestamp)?;
            let points = rquickjs::Array::new(cx.clone())?;
            for (i, p) in touch.points.iter().enumerate() {
                let o = rquickjs::Object::new(cx.clone())?;
                o.set("identifier", p.id)?;
                o.set("target", p.target)?;
                let path = rquickjs::Array::new(cx.clone())?;
                for (j, id) in p.path.iter().enumerate() {
                    path.set(j, *id)?;
                }
                o.set("path", path)?;
                o.set("pageX", p.page.x.0)?;
                o.set("pageY", p.page.y.0)?;
                o.set("locationX", p.location.x.0)?;
                o.set("locationY", p.location.y.0)?;
                o.set("changed", p.changed)?;
                o.set("timestamp", touch.timestamp)?;
                points.set(i, o)?;
            }
            obj.set("points", points)?;
        }
    }
    Ok(obj.into_value())
}

/// JSON as a JS value (owned), for natives.
pub(crate) fn json_to_js(raw: *mut qjs::JSContext, json: &nsh_core::JsonValue) -> qjs::JSValue {
    // SAFETY: a context reference; the value's ownership moves out.
    let cx = unsafe { Ctx::from_raw(std::ptr::NonNull::new_unchecked(raw)) };
    match json_value(&cx, json) {
        // A value of our own; the wrapper (and its context reference) go.
        Ok(v) => unsafe { qjs::JS_DupValue(raw, v.as_raw()) },
        Err(_) => qjs::JS_UNDEFINED,
    }
}

/// JSON (a native component's event data) as a JS value.
fn json_value<'js>(cx: &Ctx<'js>, value: &nsh_core::JsonValue) -> rquickjs::Result<Value<'js>> {
    use nsh_core::JsonValue as J;
    Ok(match value {
        J::Null => Value::new_null(cx.clone()),
        J::Bool(b) => Value::new_bool(cx.clone(), *b),
        J::Number(n) => Value::new_float(cx.clone(), n.as_f64().unwrap_or(0.0)),
        J::String(s) => rquickjs::String::from_str(cx.clone(), s)?.into_value(),
        J::Array(items) => {
            let array = rquickjs::Array::new(cx.clone())?;
            for (i, item) in items.iter().enumerate() {
                array.set(i, json_value(cx, item)?)?;
            }
            array.into_value()
        }
        J::Object(fields) => {
            let object = rquickjs::Object::new(cx.clone())?;
            for (key, item) in fields {
                object.set(key.as_str(), json_value(cx, item)?)?;
            }
            object.into_value()
        }
    })
}

/// A `Point` (`{ x, y }`).
fn point_object<'js>(
    cx: &Ctx<'js>,
    p: nsh_core::geometry::Point<nsh_core::geometry::Points>,
) -> rquickjs::Result<rquickjs::Object<'js>> {
    let obj = rquickjs::Object::new(cx.clone())?;
    obj.set("x", p.x.0)?;
    obj.set("y", p.y.0)?;
    Ok(obj)
}

/// A `Size` (`{ width, height }`).
fn size_object<'js>(
    cx: &Ctx<'js>,
    s: nsh_core::geometry::Size<nsh_core::geometry::Points>,
) -> rquickjs::Result<rquickjs::Object<'js>> {
    let obj = rquickjs::Object::new(cx.clone())?;
    obj.set("width", s.width.0)?;
    obj.set("height", s.height.0)?;
    Ok(obj)
}

/// A `Bounds` (`{ origin, size }`).
fn bounds_object<'js>(
    cx: &Ctx<'js>,
    b: nsh_core::geometry::Bounds<nsh_core::geometry::Points>,
) -> rquickjs::Result<rquickjs::Object<'js>> {
    let obj = rquickjs::Object::new(cx.clone())?;
    obj.set("origin", point_object(cx, b.origin)?)?;
    obj.set("size", size_object(cx, b.size)?)?;
    Ok(obj)
}

/// `Modifiers` (`{ control, alt, shift, platform }`, GPUI's names).
fn modifiers_object<'js>(
    cx: &Ctx<'js>,
    m: &nsh_core::keymap::Modifiers,
) -> rquickjs::Result<rquickjs::Object<'js>> {
    let obj = rquickjs::Object::new(cx.clone())?;
    obj.set("control", m.ctrl)?;
    obj.set("alt", m.alt)?;
    obj.set("shift", m.shift)?;
    obj.set("platform", m.cmd)?;
    Ok(obj)
}

fn payload_value<'js>(cx: &Ctx<'js>, value: &PayloadValue) -> rquickjs::Result<Value<'js>> {
    Ok(match value {
        PayloadValue::Number(n) => Value::new_float(cx.clone(), *n),
        PayloadValue::Bool(b) => Value::new_bool(cx.clone(), *b),
        PayloadValue::Str(s) => rquickjs::String::from_str(cx.clone(), s)?.into_value(),
        PayloadValue::Null => Value::new_null(cx.clone()),
        PayloadValue::Point(p) => point_object(cx, *p)?.into_value(),
        PayloadValue::Size(s) => size_object(cx, *s)?.into_value(),
        PayloadValue::Bounds(b) => bounds_object(cx, *b)?.into_value(),
    })
}

fn describe(value: Value<'_>) -> String {
    match value.as_exception() {
        Some(e) => e.to_string(),
        None => format!("{value:?}"),
    }
}

/// The declarations of the globals besides the web classes and functions
/// (`web/`): the host's (console, timers, frames, below) and QuickJS-NG's
/// that apps use. A test checks that each exists, and that every global
/// the host adds is declared.
pub(crate) const GLOBALS: &str = r#"declare var console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  debug(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};

declare var performance: {
  /** Milliseconds since the JS context started, with sub-millisecond precision. */
  now(): number;
};

interface ImportMeta {
  /** The module's own URL: `file:` in the app's directory on desktop hosts,
   * the page's on the web, `asset:/` in packaged mobile apps, so
   * `new URL("./data.json", import.meta.url)` names a file beside it. */
  readonly url: string;
}

declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearTimeout(id: number | undefined): void;
declare function clearInterval(id: number | undefined): void;
declare function queueMicrotask(callback: () => void): void;
/** Runs `callback` at the next display frame with its time in milliseconds. */
declare function requestAnimationFrame(callback: (time: number) => void): number;
declare function cancelAnimationFrame(id: number | undefined): void;
declare function atob(data: string): string;
declare function btoa(data: string): string;

/** `<If when={…} else={…}>…</If>`: renders its children while `when` is
 * truthy, else `else`. A function child gets an accessor of `when`'s value,
 * which is set while it shows: `<If when={user()}>{(u) => <Text>{u().name}</Text>}</If>`.
 * A global (no import), like `Each`. */
declare function If<T>(props: {
  when: T;
  else?: import("./types").JSX.Element;
  children?: import("./types").JSX.Element | ((value: () => NonNullable<T>) => import("./types").JSX.Element);
}): import("./types").JSX.Element;
declare function If(props: {
  when: unknown;
  else?: import("./types").JSX.Element;
  children?: import("./types").JSX.Element;
}): import("./types").JSX.Element;
/** `<Each of={items} key={…}>{(item, index) => …}</Each>`: renders
 * `children(item, index)` for each item of `of` (`item()` and `index()`
 * follow the row); rows are kept by `key` (default: the item; objects by
 * identity, other values by value). `key="index"` keeps rows by position:
 * a changed item updates its row's `item()` instead of making a new row
 * (a list of strings streamed in, edited in place). A global. */
declare function Each<T>(props: {
  of: readonly T[] | null | undefined;
  key?: "index" | ((item: T, index: number) => unknown);
  children: (item: () => T, index: () => number) => import("./types").JSX.Element;
}): import("./types").JSX.Element;

declare class DOMException extends Error {
  constructor(message?: string, name?: string);
  readonly name: string;
  readonly message: string;
  readonly code: number;
}
"#;

fn install(cx: &Ctx<'_>, shared: &Rc<Shared>) -> rquickjs::Result<()> {
    let globals = cx.globals();
    console::install(cx)?;
    web::install(cx.as_raw().as_ptr())?;
    crate::chunks::install(cx.as_raw().as_ptr()).map_err(|_| rquickjs::Error::Exception)?;
    crate::dom::install_globals(cx.as_raw().as_ptr());

    for (name, repeat) in [("setTimeout", false), ("setInterval", true)] {
        let s = shared.clone();
        globals.set(
            name,
            Function::new(
                cx.clone(),
                move |callback: Function<'_>, delay: Opt<f64>| -> u32 {
                    let ms = delay.0.unwrap_or(0.0);
                    let delay = Duration::from_secs_f64(if ms.is_finite() && ms > 0.0 {
                        ms / 1000.0
                    } else {
                        0.0
                    });
                    let callback = Persistent::save(&callback.ctx().clone(), callback);
                    s.timers.borrow_mut().add(callback, delay, repeat)
                },
            )?,
        )?;
    }
    let s = shared.clone();
    globals.set(
        "requestAnimationFrame",
        Function::new(cx.clone(), move |callback: Function<'_>| -> u32 {
            let id = s.next_frame_id.get().wrapping_add(1).max(1);
            s.next_frame_id.set(id);
            let callback = Persistent::save(&callback.ctx().clone(), callback);
            s.frames.borrow_mut().push((id, callback));
            id
        })?,
    )?;
    let s = shared.clone();
    globals.set(
        "cancelAnimationFrame",
        Function::new(cx.clone(), move |id: Opt<Value<'_>>| {
            if let Some(id) = handle_id(id) {
                s.frames.borrow_mut().retain(|(i, _)| *i != id);
            }
        })?,
    )?;
    for name in ["clearTimeout", "clearInterval"] {
        let s = shared.clone();
        globals.set(
            name,
            Function::new(cx.clone(), move |id: Opt<Value<'_>>| {
                if let Some(id) = handle_id(id) {
                    s.timers.borrow_mut().cancel(id);
                }
            })?,
        )?;
    }
    Ok(())
}

/// The id `clearTimeout`, `clearInterval` and `cancelAnimationFrame` were
/// given, read as the web reads it (a number, truncated; a numeric string);
/// anything else (`undefined`, `null`, objects) names no timer and is ignored,
/// never thrown at: libraries call these with ids they never got.
fn handle_id(id: Opt<Value<'_>>) -> Option<u32> {
    let id = id.0?;
    let n = match id.as_number() {
        Some(n) => n,
        None => id
            .as_string()?
            .to_string()
            .ok()?
            .trim()
            .parse::<f64>()
            .ok()?,
    };
    let n = n.trunc();
    (n.is_finite() && n >= 1.0 && n <= f64::from(u32::MAX)).then_some(n as u32)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nsh_core::{
        EventKind, Op,
        geometry::{point, px},
    };

    use super::*;

    thread_local! {
        /// Makes this thread's new VMs as `bytecode-only` runtimes make
        /// theirs ([`sourceless_context`]).
        pub(super) static SOURCELESS: Cell<bool> = const { Cell::new(false) };
    }

    /// A published web app's VM compiles no source: hardening comes as
    /// bytecode and the standard modules and globals are native. Its
    /// runtime cannot compile source at all (`bytecode-only`), so a setup
    /// step or first use that needs QuickJS' parser would stop every
    /// published app from starting.
    #[test]
    fn bytecode_only_vms_start_and_use_the_standard_apis_without_source() {
        let imports: String = crate::standard::NAMES
            .iter()
            .enumerate()
            .map(|(i, name)| format!("import * as m{i} from {name:?};\n"))
            .collect();
        let source = format!(
            r#"{imports}
            import {{ text }} from "nsh:rt";
            for (const m of [{modules}]) if (typeof m !== "object") throw Error("module");
            if (Buffer.from("nsh").toString("base64") !== "bnNo") throw Error("Buffer");
            if (crypto.randomUUID().length !== 36 || typeof crypto.subtle !== "object") throw Error("crypto");
            if (typeof process.platform !== "string" || typeof process.nextTick !== "function") throw Error("process");
            if (typeof process.run !== "function" || typeof process.env !== "object") throw Error("process");
            if (new URL("https://a.b/c").pathname !== "/c") throw Error("URL");
            const socket = new WebSocket("ws://127.0.0.1:9/");
            if (!(socket instanceof EventTarget) || socket.readyState !== WebSocket.CONNECTING) throw Error("WebSocket");
            socket.close();
            text("started");
            "#,
            modules = (0..crate::standard::NAMES.len())
                .map(|i| format!("m{i}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let bytecode = crate::compile_bytecode(&source, true).unwrap();
        let harden = crate::compile_harden().unwrap();
        SOURCELESS.set(true);
        let host = Host::with_options(HostOptions {
            harden: true,
            harden_bytecode: Some(Arc::new(harden)),
            ..HostOptions::default()
        });
        SOURCELESS.set(false);
        let host = host.unwrap();
        let error = host.eval_source("export {};").unwrap_err();
        assert!(error.message.contains("eval is not supported"), "{error}");
        host.eval_bytecode(&bytecode).unwrap();
        assert_eq!(reported(&host), ["started"]);
    }

    #[test]
    fn strings_outside_a_text_are_reported_once_per_element() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"import { append, element, insert, prop, text } from "nsh:rt";
            const view = element("view");
            insert(view, () => "a");
            insert(view, () => "b");
            const label = element("text");
            insert(label, () => "shown");
            // A Rust component places what is put in it.
            const card = element("view");
            prop(card, "component", "Card");
            insert(card, () => "placed");
            const scroll = element("scroll");
            append(scroll, text("c"));"#,
        )
        .unwrap();
        let tags = host
            .cx
            .with(|cx| crate::dom::unshown_text_tags(cx.as_raw().as_ptr()));
        let bit = |t: nsh_core::Tag| 1u64 << t as u32;
        assert_eq!(tags, bit(nsh_core::Tag::View) | bit(nsh_core::Tag::Scroll));
    }

    #[test]
    fn resources_follow_their_source_and_count_the_latest_load_only() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
import {{ effect, resource, signal }} from "nsh";
const id = signal(1);
const loads = [];
globalThis.report = report;
globalThis.id = id;
globalThis.loads = loads;
globalThis.user = resource(id, (n, info) => new Promise((resolve, reject) => {{
  loads.push({{ n, resolve, reject, info }});
  info.signal.addEventListener("abort", () => report(`aborted ${{n}}`));
}}));
effect(() => report(`${{user.state()}}|${{user() ?? ""}}|${{user.error() ?? ""}}|${{user.loading()}}`));"#
        ))
        .unwrap();
        assert_eq!(reported(&host), ["pending|||true"]);
        let step = |code: &str| {
            host.eval_source(code).unwrap();
            reported(&host)
        };
        // A new source aborts the running load; the old one ending later
        // changes nothing.
        assert_eq!(step("id.set(2);"), ["aborted 1"]);
        assert_eq!(step(r#"loads[0].resolve("one");"#), Vec::<String>::new());
        assert_eq!(step(r#"loads[1].resolve("two");"#), ["ready|two||false"]);
        // A refetch keeps the value and says so to the fetcher.
        assert_eq!(
            step("user.refetch(); report(`refetching ${loads[2].info.refetching}`);"),
            ["refreshing|two||true", "refetching true"]
        );
        // A failure keeps the value too.
        assert_eq!(
            step(r#"loads[2].reject(new Error("boom"));"#),
            ["errored|two|Error: boom|false"]
        );
        // A value set here clears the error; no source loads nothing.
        assert_eq!(step(r#"user.mutate("local");"#), ["ready|local||false"]);
        assert!(step("id.set(null);").is_empty());
        // Three loads in all: none for the unset source.
        host.eval_source("if (loads.length !== 3) throw new Error(`${loads.length} loads`);")
            .unwrap();
    }

    #[test]
    fn resources_without_a_source_with_values_and_throws() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
import {{ effect, resource }} from "nsh";
const now = resource(() => 42);
const kept = resource(() => new Promise(() => {{}}), {{ initialValue: "first" }});
const thrown = resource(() => {{ throw new Error("no"); }});
effect(() => report(`${{now.state()}} ${{now()}} | ${{kept.state()}} ${{kept()}} | ${{thrown.state()}} ${{thrown.error()}}`));
// The methods are bound: they work taken off their resource.
const {{ loading, state }} = kept;
report(`${{loading()}} ${{state()}}`);"#
        ))
        .unwrap();
        assert_eq!(
            reported(&host),
            [
                "ready 42 | refreshing first | errored Error: no",
                "true refreshing"
            ]
        );
    }

    #[test]
    fn a_resource_going_with_its_owner_aborts_its_load() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
import {{ cond, component, element, insert }} from "nsh:rt";
import {{ effect, resource, signal }} from "nsh";
const shown = signal(true);
globalThis.shown = shown;
function Card() {{
  const r = resource((info) => new Promise((resolve) => {{
    globalThis.later = resolve;
    info.signal.addEventListener("abort", () => report("aborted"));
  }}));
  effect(() => report(r.state()));
  return element("view");
}}
const root = element("view");
insert(root, cond(() => shown(), () => component(Card, {{}})));"#
        ))
        .unwrap();
        assert_eq!(reported(&host), ["pending"]);
        host.eval_source("shown.set(false);").unwrap();
        assert_eq!(reported(&host), ["aborted"]);
        // Its load ending later finds nothing to change.
        host.eval_source(r#"later("late");"#).unwrap();
        assert!(reported(&host).is_empty());
    }

    #[test]
    fn a_function_an_effect_returns_is_its_cleanup() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
import {{ cond, component, element, insert }} from "nsh:rt";
import {{ effect, signal }} from "nsh";
const n = signal(0);
const shown = signal(true);
globalThis.n = n;
globalThis.shown = shown;
function Ticker() {{
  effect(() => {{
    const v = n();
    report(`run ${{v}}`);
    return () => report(`cleanup ${{v}}`);
  }});
  // An async effect's promise is not a cleanup.
  effect(async () => {{ n(); }});
  return element("view");
}}
const root = element("view");
insert(root, cond(() => shown(), () => component(Ticker, {{}})));"#
        ))
        .unwrap();
        assert_eq!(reported(&host), ["run 0"]);
        host.eval_source("n.set(1);").unwrap();
        assert_eq!(reported(&host), ["cleanup 0", "run 1"]);
        host.eval_source("shown.set(false);").unwrap();
        assert_eq!(reported(&host), ["cleanup 1"]);
    }

    fn ops(host: &Host) -> Vec<Op> {
        let mut out = Vec::new();
        host.take_ops(&mut out);
        out
    }

    /// Reports `v` as a text node (`report(v)`; the native renderer's ops
    /// are what tests observe).
    const REPORT: &str = r#"import { text } from "nsh:rt";
const report = (v) => text(String(v));
"#;

    /// The text nodes created since the last call.
    fn reported(host: &Host) -> Vec<String> {
        ops(host)
            .into_iter()
            .filter_map(|op| match op {
                Op::CreateText { text, .. } => Some(text),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn terminal_focus_snapshots_do_not_run_jobs_or_subscribe_effects() {
        use nsh_core::{Prop, ROOT_ID, platform::Renderer};

        let host = Host::new().unwrap();
        host.set_environment(&Environment {
            renderer: Renderer::Terminal,
            ..Environment::default()
        });
        host.eval_source(
            r#"import { effect, mount, signal } from "nsh";
            import { append, element } from "nsh:rt";
            import { keymap } from "nsh/keymap";
            globalThis.keymap = keymap;
            globalThis.surface = element("view");
            globalThis.panel = element("view");
            globalThis.editor = element("input");
            globalThis.other = element("input");
            append(panel, editor);
            append(surface, panel);
            append(surface, other);
            mount(() => surface);
            keymap.bind("mod+enter", () => {}, { within: panel, when: "always" });
            globalThis.tick = signal(0);
            globalThis.effectRuns = 0;
            globalThis.effectFocused = false;
            globalThis.jobRuns = 0;
            effect(() => {
                tick();
                effectRuns++;
                effectFocused = keymap.focusedWithin(panel);
            });
            globalThis.focusErrors = [];
            globalThis.captureFocusError = (run) => {
                try { run(); focusErrors.push("accepted"); }
                catch (error) { focusErrors.push(`${error.name}: ${error.message}`); }
            };"#,
        )
        .unwrap();
        let [surface, panel, editor, other] = host.cx.with(|cx| {
            ["surface", "panel", "editor", "other"].map(|name| {
                let node: Value = cx.globals().get(name).unwrap();
                crate::dom::node_id(cx.as_raw().as_ptr(), node.as_raw()).unwrap()
            })
        });
        let table = ops(&host)
            .into_iter()
            .find_map(|op| match op {
                Op::SetProp {
                    id: ROOT_ID,
                    prop: Prop::Keymap(table),
                } => Some(table),
                _ => None,
            })
            .expect("mounted keymap");
        assert_eq!(table.bindings().len(), 1);
        assert_eq!(table.bindings()[0].within, Some(panel));
        let snapshot = || {
            host.cx.with(|cx| {
                cx.eval::<String, _>(
                    "[keymap.focusedWithin(panel), keymap.focusedWithin(editor), \
                     keymap.focusedWithin(other), effectRuns, effectFocused, jobRuns].join(',')",
                )
                .unwrap()
            })
        };
        assert_eq!(snapshot(), "false,false,false,1,false,0");
        // Queue a real job without Host's normal evaluation drain. Publishing
        // focus must neither enter it nor rerun the effect that read focus.
        host.cx.with(|cx| {
            cx.eval::<(), _>("Promise.resolve().then(() => jobRuns++);")
                .unwrap();
        });
        host.set_focus_path(&[editor, panel, surface, ROOT_ID]);
        assert_eq!(snapshot(), "true,true,false,1,false,0");
        host.set_focus_path(&[other, surface, ROOT_ID]);
        assert_eq!(snapshot(), "false,false,true,1,false,0");
        host.set_focus_path(&[]);
        assert_eq!(snapshot(), "false,false,false,1,false,0");
        host.run_jobs();
        assert_eq!(snapshot(), "false,false,false,1,false,1");
        host.set_focus_path(&[editor, panel, surface, ROOT_ID]);
        assert_eq!(snapshot(), "true,true,false,1,false,1");
        host.eval_source("tick.set(1);").unwrap();
        assert_eq!(snapshot(), "true,true,false,2,true,1");

        host.eval_source(
            r#"captureFocusError(() => keymap.focusedWithin({}));
            captureFocusError(() => keymap.bind("mod+j", () => {}, { within: {} }));"#,
        )
        .unwrap();
        host.set_environment(&Environment::default());
        host.eval_source(
            r#"captureFocusError(() => keymap.focusedWithin(panel));
            captureFocusError(() => keymap.bind("mod+j", () => {}, { within: panel }));"#,
        )
        .unwrap();
        let errors = host
            .cx
            .with(|cx| cx.globals().get::<_, Vec<String>>("focusErrors").unwrap());
        assert_eq!(
            errors,
            [
                "TypeError: keymap.focusedWithin: expected a YNode",
                "TypeError: keymap.bind within: expected a YNode",
                "TypeError: keymap.focusedWithin: requires native focus scopes",
                "TypeError: keymap.bind within: requires native focus scopes",
            ],
        );
    }

    #[test]
    fn native_focus_support_is_available_before_the_first_render() {
        let host = Host::new().unwrap();
        host.set_environment(&Environment {
            native_focus_scopes: true,
            ..Environment::default()
        });
        host.eval_source(
            r#"import { mount } from "nsh";
            import { element } from "nsh:rt";
            import { keymap } from "nsh/keymap";
            globalThis.scope = element("view");
            globalThis.keymap = keymap;
            mount(() => scope);
            keymap.bind("ctrl+j", () => {}, { within: scope });
            if (keymap.focusedWithin(scope)) throw new Error("unexpected focus");"#,
        )
        .unwrap();
        let node = host.cx.with(|cx| {
            let value: Value = cx.globals().get("scope").unwrap();
            crate::dom::node_id(cx.as_raw().as_ptr(), value.as_raw()).unwrap()
        });
        host.set_focus_path(&[node, nsh_core::ROOT_ID]);
        host.set_environment(&Environment {
            native_focus_scopes: true,
            color_scheme: nsh_core::platform::ColorScheme::Dark,
            ..Environment::default()
        });
        host.eval_source(
            "if (!keymap.focusedWithin(scope)) throw new Error('native focus was lost');",
        )
        .unwrap();
    }

    #[test]
    fn input_actions_capture_immutable_args_and_follow_component_dispatch() {
        use nsh_core::ui::JsEvent;

        let host = Host::with_options(HostOptions {
            ui_sets: vec![nsh_base::registry()],
            ..Default::default()
        })
        .unwrap();
        host.eval_source(
            r#"import { Button } from "nsh/base";
            import { inputAction, signal } from "nsh";
            globalThis.log = [];
            globalThis.source = { target: "A", nested: { value: 1 }, text: "x".repeat(70000) };
            const press = (captured) => log.push([
                captured.target, captured.nested.value, captured.text.length,
                Object.isFrozen(captured), Object.isFrozen(captured.nested)
            ].join(":"));
            let rejected = false;
            try { inputAction(press); } catch { rejected = true; }
            if (!rejected) throw Error("missing captured args accepted");
            const sparse = []; sparse.length = 2 ** 31;
            rejected = false;
            try { inputAction(press, sparse); } catch { rejected = true; }
            if (!rejected) throw Error("oversized sparse capture accepted");
            globalThis.action = signal(inputAction(press, source));
            globalThis.rebind = () => action.set(inputAction(press, { ...source, target: 'B' }));
            globalThis.bound = Button({
                get onPress() { return action(); }
            });"#,
        )
        .unwrap();
        let node = host.cx.with(|cx| {
            let node: Value = cx.globals().get("bound").unwrap();
            crate::dom::node_id(cx.as_raw().as_ptr(), node.as_raw()).unwrap()
        });
        host.eval_source("source.nested.value = 99;").unwrap();
        host.cx.with(|cx| {
            cx.eval::<(), _>("Promise.resolve().then(() => log.push('job'));")
                .unwrap();
        });
        host.deliver(JsEvent::Component {
            host: node,
            event: Box::new(nsh_base::ButtonEvent::Press),
        });
        assert_eq!(
            host.cx
                .with(|cx| cx.eval::<String, _>("log.join(',')").unwrap()),
            "A:1:70000:true:true,job",
        );

        host.eval_source("rebind();").unwrap();
        host.cx.with(|cx| {
            cx.eval::<(), _>("Promise.resolve().then(() => log.push('replacement job'));")
                .unwrap();
        });
        host.deliver(JsEvent::Component {
            host: node,
            event: Box::new(nsh_base::ButtonEvent::Press),
        });
        assert_eq!(
            host.cx
                .with(|cx| cx.eval::<String, _>("log.join(',')").unwrap()),
            "A:1:70000:true:true,job,B:99:70000:true:true,replacement job",
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_future_wakes_engine_and_resumes_without_idle_polling() {
        let host = Host::new().unwrap();
        host.scheduler.start_io().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        host.set_system_wake(Arc::new(move || {
            let _ = send.send(());
        }));
        host.cx.with(|cx| {
            cx.globals().set("nativeFutureDone", false).unwrap();
            let owned = cx.clone();
            cx.spawn(async move {
                tokio::time::sleep(Duration::from_millis(25)).await;
                owned.globals().set("nativeFutureDone", true).unwrap();
            });
        });
        host.run_jobs();
        assert!(host.has_system_tasks());
        assert!(
            !host
                .cx
                .with(|cx| cx.globals().get::<_, bool>("nativeFutureDone").unwrap())
        );
        receive
            .recv_timeout(Duration::from_secs(2))
            .expect("native timer wakes owning engine");
        host.run_system();
        assert!(
            host.cx
                .with(|cx| cx.globals().get::<_, bool>("nativeFutureDone").unwrap())
        );
        assert!(!host.has_system_tasks());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn dropping_host_cancels_pending_native_future_and_wake_callback() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let callback_dropped = Arc::new(AtomicBool::new(false));
        let host = Host::new().unwrap();
        host.scheduler.start_io().unwrap();
        let callback_guard = Dropped(callback_dropped.clone());
        host.set_system_wake(Arc::new(move || {
            let _ = &callback_guard;
        }));
        let guard = Dropped(dropped.clone());
        host.cx.with(|cx| {
            let owned = cx.clone();
            cx.spawn(async move {
                let (_guard, _owned) = (guard, owned);
                tokio::time::sleep(Duration::from_secs(60)).await;
            });
        });
        host.run_jobs();
        assert!(host.has_system_tasks());
        drop(host);
        assert!(
            dropped.load(Ordering::SeqCst),
            "pending future must be destroyed with VM"
        );
        assert!(
            callback_dropped.load(Ordering::SeqCst),
            "engine callback must not retain old generation"
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn stopping_host_cancels_native_work_without_dropping_snapshot() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let callback_dropped = Arc::new(AtomicBool::new(false));
        let host = Host::new().unwrap();
        host.scheduler.start_io().unwrap();
        let callback_guard = Dropped(callback_dropped.clone());
        host.set_system_wake(Arc::new(move || {
            let _ = &callback_guard;
        }));
        let guard = Dropped(dropped.clone());
        host.cx.with(|cx| {
            let owned = cx.clone();
            cx.spawn(async move {
                let (_guard, _owned) = (guard, owned);
                tokio::time::sleep(Duration::from_secs(60)).await;
            });
        });
        host.run_jobs();
        assert!(host.has_system_tasks());
        host.eval_source(&format!("{REPORT}report('frozen UI');"))
            .unwrap();
        host.stop("test stop".into());
        assert!(!host.cx.is_live());
        assert!(host.rt.borrow().is_none());
        assert_eq!(reported(&host), ["frozen UI"]);
        assert!(!host.has_system_tasks());
        assert!(!host.has_posted());
        assert!(!host.wants_frame());
        assert!(host.next_timer().is_none());
        assert_eq!(host.object_count(), 0);
        host.run_jobs();
        host.run_system();
        host.run_posted();
        host.run_frame();
        host.collect_garbage();
        host.set_stop_flag(Arc::new(AtomicBool::new(false)));
        host.take_chunk_requests(&mut Vec::new());
        assert!(host.eval_source("throw 1").is_err());
        host.stop("repeated stop".into());
        assert!(
            dropped.load(Ordering::SeqCst),
            "pending future must be destroyed with VM"
        );
        assert!(
            callback_dropped.load(Ordering::SeqCst),
            "engine callback must not retain old generation"
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn top_level_await_resumes_and_reports_rejection_on_native_wake() {
        let mut host = Host::new().unwrap();
        host.scheduler.start_io().unwrap();
        let errors = Rc::new(RefCell::new(Vec::new()));
        let captured = errors.clone();
        host.set_error_handler(Box::new(move |error| {
            captured.borrow_mut().push(error.message.clone())
        }));
        let (send, receive) = std::sync::mpsc::channel();
        host.set_system_wake(Arc::new(move || {
            let _ = send.send(());
        }));
        host.cx.with(|cx| {
            let promise = Promise::wrap_future(&cx, async {
                tokio::time::sleep(Duration::from_millis(25)).await;
                7
            })
            .unwrap();
            cx.globals().set("nativePending", promise).unwrap();
        });
        host.eval_source("await nativePending; throw new Error('native TLA rejected');")
            .unwrap();
        assert_eq!(host.evaluations.borrow().len(), 1);
        receive.recv_timeout(Duration::from_secs(2)).unwrap();
        host.run_system();
        assert!(host.evaluations.borrow().is_empty());
        assert!(
            errors
                .borrow()
                .iter()
                .any(|error| error.contains("native TLA rejected"))
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn oom_retires_pending_native_future_without_dropping_host() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let host = sandboxed(Limits {
            memory_bytes: 16 << 20,
            ..Limits::default()
        });
        host.scheduler.start_io().unwrap();
        let guard = Dropped(dropped.clone());
        host.cx.with(|cx| {
            cx.spawn(async move {
                let _guard = guard;
                tokio::time::sleep(Duration::from_secs(60)).await;
            })
        });
        host.run_jobs();
        let _ = host.eval_source(
            "try { const keep=[]; for (;;) keep.push(new Array(100000).fill(1)); } catch (_) {}",
        );
        assert!(host.fatal().is_some());
        assert!(!host.cx.is_live());
        assert!(host.rt.borrow().is_none());
        assert!(dropped.load(Ordering::SeqCst));
        assert!(!host.has_system_tasks());
    }

    #[test]
    fn stopping_host_releases_exit_delegate_and_refuses_replacement() {
        let host = Host::new().unwrap();
        let captured = Rc::new(());
        let retained = captured.clone();
        host.set_exit_handler(Rc::new(move |_| {
            let _ = &retained;
        }));
        assert_eq!(Rc::strong_count(&captured), 2);
        host.stop("test exit delegate lifetime".into());
        assert_eq!(Rc::strong_count(&captured), 1);
        assert!(host.shared.system_exit_handler.borrow().is_none());
        let retained = captured.clone();
        host.set_exit_handler(Rc::new(move |_| {
            let _ = &retained;
        }));
        assert_eq!(Rc::strong_count(&captured), 1);
        assert!(host.shared.system_exit_handler.borrow().is_none());
        host.stop("idempotent stop".into());
    }

    #[test]
    fn press_payload_has_both_positions() {
        let host = Host::new().unwrap();
        let event = nsh_core::PressEvent {
            position: point(px(3.0), px(4.5)),
            page_position: point(px(30.0), px(40.5)),
            modifiers: nsh_core::keymap::Modifiers {
                ctrl: true,
                ..Default::default()
            },
            clicks: 2,
        };
        host.cx.with(|cx| {
            let value = payload_object(&cx, &EventPayload::Press(event)).unwrap();
            let obj = value.as_object().unwrap();
            let num = |o: &str, k: &str| {
                let o: rquickjs::Object = obj.get(o).unwrap();
                o.get::<_, f64>(k).unwrap()
            };
            assert_eq!(
                (
                    num("position", "x"),
                    num("position", "y"),
                    num("pagePosition", "x"),
                    num("pagePosition", "y")
                ),
                (3.0, 4.5, 30.0, 40.5)
            );
            let modifiers: rquickjs::Object = obj.get("modifiers").unwrap();
            assert!(modifiers.get::<_, bool>("control").unwrap());
            assert!(!modifiers.get::<_, bool>("shift").unwrap());
            assert_eq!(obj.get::<_, u32>("clickCount").unwrap(), 2);
        });
    }

    #[test]
    fn hover_payload_has_both_positions_and_the_modifiers() {
        let host = Host::new().unwrap();
        let event = nsh_core::HoverEvent {
            position: point(px(3.0), px(4.5)),
            page_position: point(px(30.0), px(40.5)),
            modifiers: nsh_core::keymap::Modifiers {
                shift: true,
                cmd: true,
                ..Default::default()
            },
        };
        host.cx.with(|cx| {
            let value = payload_object(&cx, &EventPayload::Hover(event)).unwrap();
            let obj = value.as_object().unwrap();
            let num = |o: &str, k: &str| {
                let o: rquickjs::Object = obj.get(o).unwrap();
                o.get::<_, f64>(k).unwrap()
            };
            let flag = |k: &str| {
                let m: rquickjs::Object = obj.get("modifiers").unwrap();
                m.get::<_, bool>(k).unwrap()
            };
            assert_eq!(
                (
                    num("position", "x"),
                    num("position", "y"),
                    num("pagePosition", "x"),
                    num("pagePosition", "y")
                ),
                (3.0, 4.5, 30.0, 40.5)
            );
            assert!(flag("shift") && flag("platform"));
            assert!(!flag("alt") && !flag("control"));
        });
    }

    #[test]
    fn context_menu_payload_has_both_positions() {
        let host = Host::new().unwrap();
        let event = nsh_core::ContextMenuEvent {
            position: point(px(1.0), px(2.0)),
            page_position: point(px(11.0), px(22.0)),
            modifiers: nsh_core::keymap::Modifiers {
                ctrl: true,
                ..Default::default()
            },
        };
        host.cx.with(|cx| {
            let value = payload_object(&cx, &EventPayload::ContextMenu(event)).unwrap();
            let obj = value.as_object().unwrap();
            let num = |o: &str, k: &str| {
                let o: rquickjs::Object = obj.get(o).unwrap();
                o.get::<_, f64>(k).unwrap()
            };
            assert_eq!(
                (
                    num("position", "x"),
                    num("position", "y"),
                    num("pagePosition", "x"),
                    num("pagePosition", "y")
                ),
                (1.0, 2.0, 11.0, 22.0)
            );
            let m: rquickjs::Object = obj.get("modifiers").unwrap();
            assert!(m.get::<_, bool>("control").unwrap());
            assert!(!m.get::<_, bool>("platform").unwrap());
        });
    }

    #[test]
    fn file_drop_payload_keeps_the_native_uri_list() {
        let host = Host::new().unwrap();
        let uris = vec![
            "file:///tmp/a%20b.txt".into(),
            "file:///tmp/%E4%B8%AD%E6%96%87/".into(),
        ];
        host.cx.with(|cx| {
            let value = payload_object(&cx, &EventPayload::FileDrop(uris.clone())).unwrap();
            let actual: Vec<String> = value.as_object().unwrap().get("uris").unwrap();
            assert_eq!(actual, uris);
        });
    }

    #[test]
    fn paste_payload_hands_files_over_as_file_objects() {
        let host = Host::new().unwrap();
        let mut paste = nsh_core::PasteEvent::new("hi");
        paste.files.push(nsh_core::PastedFile::image(vec![
            0x89, b'P', b'N', b'G', 1, 2,
        ]));
        paste.uris.push("file:///tmp/a.txt".into());
        host.cx.with(|cx| {
            let value = payload_object(&cx, &EventPayload::Paste(Box::new(paste))).unwrap();
            cx.globals().set("pasted", value).unwrap();
            let summary: String = cx
                .eval(
                    "const f = pasted.files[0]; \
                     `${pasted.text} ${f instanceof File} ${f.name} ${f.type} ${f.size} ${pasted.uris[0]}`",
                )
                .unwrap();
            assert_eq!(summary, "hi true image.png image/png 6 file:///tmp/a.txt");
        });
    }

    #[test]
    fn styles_decode_shadows_and_corners() {
        let host = Host::new().unwrap();
        host.eval_source(
            r##"import { element, prop } from "nsh:rt";
            prop(element("view"), "style", {
                flexDirection: "row", backgroundColor: "#ff0000", bogus: 1,
                shadowColor: "#000", shadowOffset: { width: 2, height: 6 },
                shadowOpacity: 0.25, shadowRadius: 10,
                borderRadius: 12, borderBottomLeftRadius: 0,
            });
            prop(element("view"), "style", { shadowOffset: null });"##,
        )
        .unwrap();
        let styles: Vec<_> = ops(&host)
            .into_iter()
            .filter_map(|op| match op {
                Op::SetStyle { style, .. } => Some(style),
                _ => None,
            })
            .collect();
        let style = &styles[0];
        assert_eq!(format!("{:?}", style.layout.flex_direction), "Row");
        assert_eq!(style.view.background_color, nsh_core::Color(0xff00_00ff));
        let shadow = style.view.shadow;
        assert_eq!((shadow.offset_x.0, shadow.offset_y.0), (2.0, 6.0));
        assert_eq!((shadow.opacity, shadow.radius.0), (0.25, 10.0));
        assert_eq!(
            style.view.radii().to_array().map(|r| r.0),
            [12.0, 12.0, 12.0, 0.0]
        );
        assert_eq!(styles[1].view.shadow, nsh_core::Shadow::DEFAULT);
    }

    /// `style={[base, props.style]}` where `props.style` is itself a list:
    /// nested lists merge left to right, falsy entries skipped.
    #[test]
    fn styles_flatten_nested_lists() {
        let host = Host::new().unwrap();
        host.eval_source(
            r##"import { element, prop } from "nsh:rt";
            const inner = [{ opacity: 0.5 }, false, [null, { backgroundColor: "#00ff00" }]];
            prop(element("view"), "style", [
                { flexDirection: "row", backgroundColor: "#ff0000", opacity: 1 },
                inner,
                undefined,
            ]);"##,
        )
        .unwrap();
        let style = ops(&host)
            .into_iter()
            .find_map(|op| match op {
                Op::SetStyle { style, .. } => Some(style),
                _ => None,
            })
            .unwrap();
        assert_eq!(format!("{:?}", style.layout.flex_direction), "Row");
        assert_eq!(style.view.background_color, nsh_core::Color(0x00ff_00ff));
        assert_eq!(style.view.opacity, 0.5);
    }

    /// `Intl` and the `toLocaleString`s format natively, in the device's
    /// locale by default.
    #[test]
    fn intl_formats_numbers_and_dates() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
            report((1234567.891).toLocaleString());
            report((1234.5).toLocaleString("de-DE", {{ style: "currency", currency: "EUR" }}));
            report((0.256).toLocaleString("en-US", {{ style: "percent", maximumFractionDigits: 1 }}));
            report(12345678901234567890n.toLocaleString("en-US"));
            const compact = new Intl.NumberFormat("en", {{ notation: "compact" }});
            report([1234, 1500000, 999999].map(compact.format).join(" "));
            report(new Intl.NumberFormat("en", {{ signDisplay: "always", minimumFractionDigits: 2 }}).format(3));
            report(new Intl.NumberFormat("en", {{ useGrouping: false }}).format(12345));
            report(JSON.stringify(new Intl.NumberFormat("en", {{ style: "currency", currency: "USD" }}).formatToParts(-1.5)));
            report(new Intl.NumberFormat("fr").resolvedOptions().locale);
            const at = Date.UTC(2026, 9, 16, 15, 4, 5);
            const utc = {{ timeZone: "UTC" }};
            report(new Intl.DateTimeFormat("en-US", {{ ...utc, hour: "2-digit", minute: "2-digit", hour12: false }}).format(at));
            report(new Date(at).toLocaleString("en-US", utc));
            report(new Date(at).toLocaleDateString("en-US", {{ ...utc, dateStyle: "full" }}));
            report(new Date(at).toLocaleTimeString("ko-KR", {{ timeZone: "+09:00" }}));
            report(new Intl.DateTimeFormat("en-US", {{ timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }}).format(new Date(at)));
            report(new Intl.DateTimeFormat().resolvedOptions().locale);
            report(new Date(NaN).toLocaleString());
            try {{ new Intl.NumberFormat("en", {{ style: "currency" }}); }} catch (e) {{ report(e.name); }}
            try {{ new Intl.DateTimeFormat("en", {{ timeZone: "Mars/Olympus" }}); }} catch (e) {{ report(e.name); }}
            report(Intl.NumberFormat.supportedLocalesOf(["xx", "ja-jp"]).join());
            report(Object.prototype.toString.call(Intl));
            "#
        ))
        .unwrap();
        assert_eq!(
            reported(&host),
            [
                "1,234,567.891",
                "1.234,50\u{a0}€",
                "25.6%",
                "12,345,678,901,234,567,890",
                "1.2K 1.5M 1M",
                "+3.00",
                "12345",
                r#"[{"type":"minusSign","value":"-"},{"type":"currency","value":"$"},{"type":"integer","value":"1"},{"type":"decimal","value":"."},{"type":"fraction","value":"50"}]"#,
                "fr",
                "15:04",
                "10/16/2026, 3:04:05 PM",
                "Friday, October 16, 2026",
                "오전 12:04:05",
                "Oct 16, 2026, 3:04 PM",
                "en-US",
                "Invalid Date",
                "TypeError",
                "RangeError",
                "ja-JP",
                "[object Intl]",
            ]
        );
    }

    #[test]
    fn timers_fire_in_order_and_cancel() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            globalThis.log = [];
            setTimeout(() => log.push("b"), 20);
            setTimeout(() => log.push("a"), 0);
            const c = setTimeout(() => log.push("cancelled"), 10);
            clearTimeout(c);
            Promise.resolve().then(() => log.push("micro"));
            "#,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_millis(30);
        while let Some(next) = host.next_timer() {
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
            host.run_timers(Instant::now());
            assert!(Instant::now() < deadline + Duration::from_secs(1));
        }
        host.eval_source(&format!("{REPORT}report(log.join(\",\"));"))
            .unwrap();
        assert_eq!(reported(&host), ["micro,a,b"]);
    }

    #[test]
    fn clearing_ids_that_name_no_timer_is_ignored() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            globalThis.log = [];
            const t = setTimeout(() => log.push("timeout"), 0);
            const i = setInterval(() => { log.push("interval"); clearInterval(i); }, 0);
            const f = requestAnimationFrame(() => log.push("frame"));
            for (const clear of [clearTimeout, clearInterval, cancelAnimationFrame]) {
                clear();
                for (const id of [undefined, null, 0, -1, NaN, Infinity, 1e12, 0.5, 99999, "x", "", {}, [], true, Symbol()])
                    clear(id);
            }
            const gone = setTimeout(() => log.push("cancelled by string"), 0);
            clearTimeout(String(gone));
            const gone2 = setTimeout(() => log.push("cancelled by fraction"), 0);
            clearTimeout(gone2 + 0.7);
            const gone3 = requestAnimationFrame(() => log.push("cancelled frame"));
            cancelAnimationFrame(gone3);
            "#,
        )
        .unwrap();
        host.run_frame();
        while let Some(next) = host.next_timer() {
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
            host.run_timers(Instant::now());
        }
        host.eval_source(&format!("{REPORT}report(log.join(\",\"));"))
            .unwrap();
        assert_eq!(reported(&host), ["frame,timeout,interval"]);
    }

    fn sandboxed(limits: Limits) -> Host {
        Host::with_options(HostOptions {
            limits,
            harden: true,
            ..HostOptions::default()
        })
        .unwrap()
    }

    #[test]
    fn calls_over_budget_are_interrupted_and_the_vm_goes_on() {
        let mut host = sandboxed(Limits {
            call_budget: Duration::from_millis(50),
            ..Limits::default()
        });
        let errors = Rc::new(RefCell::new(Vec::new()));
        let seen = errors.clone();
        host.set_error_handler(Box::new(move |e| seen.borrow_mut().push(e.message.clone())));
        // Views 2 and 4: the first loops when pressed.
        host.eval_source(
            r#"import { element, prop } from "nsh:rt";
            globalThis.views = [true, false].map((loops) => {
                const view = element("view");
                prop(view, "onPress", () => {
                    // try/catch cannot swallow the interrupt.
                    try { if (loops) for (;;) {} } catch (e) {}
                    element("view");
                });
                return view;
            });"#,
        )
        .unwrap();
        ops(&host);
        let start = Instant::now();
        host.dispatch_event(2, EventKind::Press, &EventPayload::None);
        assert!(start.elapsed() < Duration::from_secs(2));
        let errors = errors.borrow().clone();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("budget of 50 ms"), "{}", errors[0]);
        assert!(ops(&host).is_empty());
        // The next call runs normally.
        host.dispatch_event(4, EventKind::Press, &EventPayload::None);
        let created = ops(&host)
            .into_iter()
            .filter(|op| matches!(op, Op::Create { .. }))
            .count();
        assert_eq!(created, 1);
        assert!(host.fatal().is_none());
    }

    #[test]
    fn running_out_of_memory_stops_the_vm() {
        let host = sandboxed(Limits {
            memory_bytes: 16 << 20,
            ..Limits::default()
        });
        let err = host
            .eval_source("const keep = []; for (;;) keep.push(new Array(100000).fill(1));")
            .unwrap_err();
        assert!(err.message.contains("limited to 16 MB"), "{}", err.message);
        assert!(host.fatal().is_some());
        // Nothing runs any more.
        assert!(
            host.eval_source(r#"import { element } from "nsh:rt"; element("view");"#)
                .is_err()
        );
        assert!(ops(&host).is_empty());
    }

    #[test]
    fn running_out_of_memory_in_a_timer_stops_the_vm() {
        let mut host = sandboxed(Limits {
            memory_bytes: 16 << 20,
            ..Limits::default()
        });
        let errors = Rc::new(RefCell::new(Vec::new()));
        let seen = errors.clone();
        host.set_error_handler(Box::new(move |e| seen.borrow_mut().push(e.message.clone())));
        // JSON.parse running out throws a null exception, not the usual
        // InternalError.
        host.eval_source(
            r#"const keep = [];
            setTimeout(() => {
                for (let n = 0; ; n++) {
                    const parts = [];
                    for (let i = 0; i < 1000; i++) parts.push(`{"path":"/a/b/c-${n}-${i}","children":[]}`);
                    keep.push(JSON.parse("[" + parts.join(",") + "]"));
                }
            }, 0);"#,
        )
        .unwrap();
        host.run_timers(Instant::now() + Duration::from_millis(1));
        let errors = errors.borrow().clone();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("limited to 16 MB"), "{}", errors[0]);
        assert!(host.fatal().is_some());
    }

    #[test]
    fn running_out_of_memory_stops_the_vm_even_when_caught() {
        let mut host = sandboxed(Limits {
            memory_bytes: 16 << 20,
            ..Limits::default()
        });
        let errors = Rc::new(RefCell::new(Vec::new()));
        let seen = errors.clone();
        host.set_error_handler(Box::new(move |e| seen.borrow_mut().push(e.message.clone())));
        host.eval_source(
            r#"setTimeout(() => {
                try {
                    const keep = [];
                    for (;;) keep.push(new Array(100000).fill(1));
                } catch (e) {}
            }, 0);"#,
        )
        .unwrap();
        host.run_timers(Instant::now() + Duration::from_millis(1));
        let errors = errors.borrow().clone();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(
            errors[0].contains("limited to 16 MB") && errors[0].contains("in pages"),
            "{}",
            errors[0]
        );
        assert!(host.fatal().is_some());
    }

    #[test]
    fn too_many_changes_at_once_stop_the_vm() {
        let host = sandboxed(Limits {
            max_op_values: 1000,
            ..Limits::default()
        });
        assert!(
            host.eval_source(
                r#"import { element } from "nsh:rt"; for (let i = 0; i < 2000; i++) element("view");"#
            )
            .is_err()
        );
        assert!(host.fatal().unwrap().contains("more than 1000 changes"));
    }

    #[test]
    fn hardened_vms_run_no_code_from_strings() {
        // Hardened from source, and from the bytecode the CLI ships to
        // runtimes without a parser.
        let from_bytecode = Host::with_options(HostOptions {
            harden: true,
            harden_bytecode: Some(crate::compile_harden().unwrap().into()),
            ..HostOptions::default()
        })
        .unwrap();
        for host in [sandboxed(Limits::default()), from_bytecode] {
            hardened_vm_runs_no_code_from_strings(&host);
        }
    }

    fn hardened_vm_runs_no_code_from_strings(host: &Host) {
        host.eval_source(&(REPORT.to_owned()
            + r#"
            const results = [];
            const attempt = (f) => { try { f(); results.push("ran"); } catch (e) { results.push(e.constructor.name); } };
            attempt(() => eval("1"));
            attempt(() => new Function("return 1")());
            attempt(() => (function () {}).constructor("return 1")());
            attempt(() => (async function () {}).constructor("return 1"));
            attempt(() => (function* () {}).constructor("yield 1"));
            attempt(() => { "use strict"; Array.prototype.map = null; });
            attempt(() => { "use strict"; Object.prototype.polluted = 1; });
            // Ordinary code is unaffected.
            class MyError extends Error { constructor() { super("x"); this.name = "MyError"; } }
            attempt(() => { const e = new MyError(); if (e.name !== "MyError") throw new Error(); });
            attempt(() => [1, 2].map((x) => x * 2));
            // Members of the frozen prototypes can still be overridden on
            // other objects (no override mistake), not on the prototypes.
            attempt(() => {
                "use strict";
                function A() {}
                A.prototype = Object.create(Object.prototype);
                A.prototype.constructor = A;
                const o = { toString: undefined };
                o.toString = () => "mine";
                const d = new Date(0);
                d.toJSON = () => "j";
                if (new A().constructor !== A || String(o) !== "mine" || JSON.stringify(d) !== '"j"') throw new Error();
                if (({}).constructor !== Object || [].toString() !== "") throw new Error();
            });
            attempt(() => { "use strict"; Object.prototype.toString = null; });
            report(results.join(","));
            "#))
        .unwrap();
        assert_eq!(
            reported(host),
            [
                "ReferenceError,TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,ran,ran,ran,TypeError"
            ]
        );
    }

    #[test]
    fn development_vms_keep_eval() {
        let host = Host::new().unwrap();
        host.eval_source(&format!("{REPORT}report(eval(\"1 + 1\"));"))
            .unwrap();
        assert_eq!(reported(&host), ["2"]);
    }

    /// Captures the `js` errors logged on this thread (each test runs on
    /// a thread of its own, its host too).
    mod logs {
        use std::cell::RefCell;

        struct Capture;

        thread_local! {
            static LINES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
        }

        impl log::Log for Capture {
            fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
                metadata.target() == "js" && metadata.level() == log::Level::Error
            }

            fn log(&self, record: &log::Record<'_>) {
                if self.enabled(record.metadata()) {
                    LINES.with_borrow_mut(|lines| lines.push(record.args().to_string()));
                }
            }

            fn flush(&self) {}
        }

        static CAPTURE: Capture = Capture;

        /// Captures from here on (the logger is the process's: installed
        /// once).
        pub(super) fn capture() {
            static INSTALL: std::sync::Once = std::sync::Once::new();
            INSTALL.call_once(|| {
                if log::set_logger(&CAPTURE).is_ok() {
                    log::set_max_level(log::LevelFilter::Error);
                }
            });
            LINES.with_borrow_mut(Vec::clear);
        }

        /// The lines logged since the last call.
        pub(super) fn take() -> Vec<String> {
            LINES.with_borrow_mut(std::mem::take)
        }
    }

    /// Lines about unhandled rejections among `lines`.
    fn rejections(lines: &[String]) -> Vec<&String> {
        lines
            .iter()
            .filter(|l| l.contains("unhandled rejection"))
            .collect()
    }

    #[test]
    fn unhandled_rejections_are_logged_once_the_turn_ends() {
        logs::capture();
        let host = Host::new().unwrap();
        host.eval_source(
            r#"function fail() { return Promise.reject(new Error("boom")); }
            fail();
            Promise.reject("plain");"#,
        )
        .unwrap();
        let lines = logs::take();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(
            lines[0].starts_with("unhandled rejection: Error: boom")
                && lines[0].contains("at fail"),
            "{}",
            lines[0]
        );
        assert_eq!(lines[1], "unhandled rejection: plain");
        // Reported once: the next turns have nothing left.
        host.run_jobs();
        host.collect_garbage();
        assert!(logs::take().is_empty());
        assert_eq!(host.pending_rejections(), 0);
    }

    #[test]
    fn rejections_handled_in_the_same_turn_are_not_logged() {
        logs::capture();
        let host = Host::new().unwrap();
        host.eval_source(
            r#"// A handler attached later in the same code.
            const p = Promise.reject(new Error("later"));
            const other = 1 + 1;
            p.catch(() => {});
            // One attached by a microtask of the same turn.
            const q = Promise.reject(new Error("micro"));
            Promise.resolve().then(() => Promise.resolve()).then(() => q.catch(() => {}));
            // Handled the usual ways.
            Promise.reject(new Error("caught")).catch(() => {});
            Promise.reject(new Error("then")).then(undefined, () => {});
            Promise.reject(new Error("chain")).then(() => 1).catch(() => {});
            (async () => { try { await Promise.reject(new Error("awaited")); } catch (e) {} })();
            Promise.allSettled([Promise.reject(new Error("settled"))]);"#,
        )
        .unwrap();
        assert_eq!(logs::take(), Vec::<String>::new());
        assert_eq!(host.pending_rejections(), 0);
    }

    #[test]
    fn a_rejection_left_by_a_chain_is_logged_once() {
        logs::capture();
        let host = Host::new().unwrap();
        // The first promise is handled by `then`, which rejects in turn.
        host.eval_source(r#"Promise.reject(new Error("chained")).then(() => 1);"#)
            .unwrap();
        let lines = logs::take();
        assert_eq!(rejections(&lines).len(), 1, "{lines:?}");
        assert!(lines[0].contains("chained"), "{}", lines[0]);
    }

    #[test]
    fn async_functions_that_throw_unawaited_are_logged() {
        logs::capture();
        let host = Host::new().unwrap();
        host.eval_source(
            r#"async function now() { throw new Error("at once"); }
            async function later() { await null; throw new TypeError("after await"); }
            setTimeout(() => { now(); later(); }, 0);"#,
        )
        .unwrap();
        assert!(logs::take().is_empty());
        host.run_timers(Instant::now() + Duration::from_millis(1));
        let lines = logs::take();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(
            lines[0].contains("at once") && lines[0].contains("at now"),
            "{}",
            lines[0]
        );
        assert!(lines[1].contains("after await"), "{}", lines[1]);
    }

    #[test]
    fn a_rejection_handled_in_a_later_turn_is_logged_once() {
        logs::capture();
        let host = Host::new().unwrap();
        host.eval_source(
            r#"const p = Promise.reject(new Error("too late"));
            setTimeout(() => p.catch(() => {}), 0);"#,
        )
        .unwrap();
        assert_eq!(rejections(&logs::take()).len(), 1);
        host.run_timers(Instant::now() + Duration::from_millis(1));
        assert!(logs::take().is_empty());
        assert_eq!(host.pending_rejections(), 0);
    }

    #[test]
    fn rejections_go_to_the_handler_not_the_error_handler() {
        logs::capture();
        let mut host = Host::new().unwrap();
        let (errors, rejected) = (
            Rc::new(RefCell::new(Vec::new())),
            Rc::new(RefCell::new(Vec::new())),
        );
        let seen = errors.clone();
        host.set_error_handler(Box::new(move |e| seen.borrow_mut().push(e.message.clone())));
        let seen = rejected.clone();
        host.set_rejection_handler(Box::new(move |e| seen.borrow_mut().push(e.message.clone())));
        host.eval_source(r#"Promise.reject(new Error("to the handler"));"#)
            .unwrap();
        assert!(errors.borrow().is_empty());
        assert_eq!(rejected.borrow().len(), 1);
        assert!(rejected.borrow()[0].starts_with("Error: to the handler"));
        assert!(logs::take().is_empty());
    }

    #[test]
    fn a_failing_bundle_is_not_an_unhandled_rejection() {
        logs::capture();
        let host = Host::new().unwrap();
        let err = host
            .eval_source(r#"throw new Error("top level");"#)
            .unwrap_err();
        assert!(err.message.contains("top level"), "{}", err.message);
        assert!(rejections(&logs::take()).is_empty());
        assert_eq!(host.pending_rejections(), 0);
    }

    #[test]
    fn many_rejections_leave_nothing_behind() {
        logs::capture();
        let host = Host::new().unwrap();
        host.eval_source(
            r#"globalThis.reject = (n) => {
                for (let i = 0; i < n; i++) {
                    Promise.reject(new Error("unhandled " + i));
                    Promise.reject(new Error("handled " + i)).catch(() => {});
                    (async () => { throw new Error("async " + i); })();
                }
            };
            setTimeout(() => reject(1), 0);"#,
        )
        .unwrap();
        host.run_timers(Instant::now() + Duration::from_millis(1));
        logs::take();
        host.collect_garbage();
        let before = host.object_count();
        host.eval_script(
            "rounds.js",
            "for (let i = 0; i < 20; i++) setTimeout(() => reject(50), 0);",
        )
        .unwrap();
        host.run_timers(Instant::now() + Duration::from_millis(1));
        assert_eq!(rejections(&logs::take()).len(), 20 * 50 * 2);
        assert_eq!(host.pending_rejections(), 0);
        host.collect_garbage();
        // The 3000 promises and their errors are gone.
        assert!(
            host.object_count() < before + 100,
            "{} → {}",
            before,
            host.object_count()
        );
    }

    #[test]
    fn interrupts_and_running_out_of_memory_are_not_rejections() {
        logs::capture();
        let mut host = sandboxed(Limits {
            call_budget: Duration::from_millis(50),
            ..Limits::default()
        });
        let errors = Rc::new(RefCell::new(Vec::new()));
        let seen = errors.clone();
        host.set_error_handler(Box::new(move |e| seen.borrow_mut().push(e.message.clone())));
        host.eval_source(
            r#"setTimeout(async () => { await null; for (;;) {} }, 0);
            setTimeout(async () => { try { for (;;) {} } catch (e) {} }, 0);"#,
        )
        .unwrap();
        host.run_timers(Instant::now() + Duration::from_millis(1));
        assert_eq!(errors.borrow().len(), 2, "{:?}", errors.borrow());
        assert!(
            errors
                .borrow()
                .iter()
                .all(|e| e.contains("budget of 50 ms"))
        );
        assert_eq!(rejections(&logs::take()), Vec::<&String>::new());
        assert_eq!(host.pending_rejections(), 0);

        let mut host = sandboxed(Limits {
            memory_bytes: 16 << 20,
            ..Limits::default()
        });
        let errors = Rc::new(RefCell::new(Vec::new()));
        let seen = errors.clone();
        host.set_error_handler(Box::new(move |e| seen.borrow_mut().push(e.message.clone())));
        host.eval_source(
            r#"setTimeout(async () => {
                const keep = [];
                for (;;) keep.push(new Array(100000).fill(1));
            }, 0);"#,
        )
        .unwrap();
        host.run_timers(Instant::now() + Duration::from_millis(1));
        assert_eq!(errors.borrow().len(), 1, "{:?}", errors.borrow());
        assert!(errors.borrow()[0].contains("limited to 16 MB"));
        assert_eq!(rejections(&logs::take()), Vec::<&String>::new());
    }
}
