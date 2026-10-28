//! A browser-owned JavaScript host for the local engine.
//!
//! The browser loads ES modules asynchronously after `LocalEngine::start`.
//! This boundary only exchanges typed operations and events; it does not
//! evaluate source or accept QuickJS bytecode. The host schedules a pump
//! after each browser turn and stops accepting callbacks when disposed.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, atomic::AtomicBool},
};

use nsh_core::{
    EventKind, EventPayload, NodeId, Op, TextEngine,
    element::{JsEvent, Posts, Registry, ThemeTokens, Tokens},
    time::Instant,
};

use crate::{
    AppError, AppErrorKind, Bundle, BundleCode, Chunk, Environment, FetchEvent, HotUpdate, Limits,
    MountSink,
    script::{NetworkQueue, SystemConfig},
};

/// Services attached to a browser host when its local engine starts.
#[non_exhaustive]
pub struct Services {
    /// The same capability-scoped Rust system services supplied to native JS.
    pub system: nsh_core::element::System,
    /// The embedding host bridge.
    pub host: Rc<dyn nsh_core::host_channel::HostBridge>,
    /// Wakes the local engine after browser callbacks.
    pub wake: Arc<dyn Fn() + Send + Sync>,
    /// The UI sets registered by this app and its runtime.
    pub registries: Vec<Registry>,
    /// Calls posted by Rust, ordered with operations from JavaScript.
    pub posts: Posts,
    /// The initial device environment.
    pub environment: Environment,
    /// The initial design tokens.
    pub tokens: Arc<Tokens>,
    /// The initial theme.
    pub theme: ThemeTokens,
}

impl Default for Services {
    fn default() -> Self {
        Self {
            system: Default::default(),
            host: Rc::new(UnconfiguredHost),
            wake: Arc::new(|| {}),
            registries: Vec::new(),
            posts: Default::default(),
            environment: Default::default(),
            tokens: Default::default(),
            theme: Default::default(),
        }
    }
}

struct UnconfiguredHost;
impl nsh_core::host_channel::HostBridge for UnconfiguredHost {
    fn available(&self) -> bool {
        false
    }
    fn params(&self) -> nsh_core::JsonValue {
        serde_json::json!({})
    }
    fn call(&self, _: u64, _: &str, _: nsh_core::JsonValue) -> Result<(), String> {
        Err("no embedding host was configured".into())
    }
    fn post(&self, _: &str, _: nsh_core::JsonValue) {}
}

/// The browser's side of an engine turn. Implementations must not retain
/// a mutable state borrow across a call into JavaScript: callbacks can
/// synchronously reenter the host. Disposal invalidates all pending work.
pub trait Host {
    /// Attach the core before the browser imports the entry module.
    fn initialize(&self, services: Services) -> Result<(), String>;
    /// Take operations queued by completed JavaScript calls.
    fn take_ops(&self, out: &mut Vec<Op>);
    /// Deliver a native input event.
    fn dispatch_event(&self, id: NodeId, event: EventKind, payload: &EventPayload);
    /// Deliver typed Rust results, component events and render requests.
    fn deliver(&self, event: JsEvent);
    /// Bind the reusable cells of a virtual list.
    fn bind_list(&self, list: NodeId, binds: &[(u32, u32)]);
    /// Run callbacks posted by Rust, preserving their order.
    fn run_posted(&self);
    /// Whether callbacks remain queued.
    fn has_posted(&self) -> bool;
    /// Update the device environment.
    fn set_environment(&self, environment: &Environment);
    /// Update design tokens.
    fn set_tokens(&self, tokens: Arc<Tokens>);
    /// Update the theme.
    fn set_theme_tokens(&self, theme: ThemeTokens);
    /// Take fonts registered by loaded modules.
    fn take_fonts(&self, out: &mut Vec<String>);
    /// Whether the browser host needs an animation frame.
    fn wants_frame(&self) -> bool;
    /// Deliver an animation frame.
    fn run_frame(&self);
    /// Complete native animations.
    fn animations_finished(&self, finished: &[nsh_core::animation::Finished]);
    /// Deliver an embedding host event.
    fn host_event(&self, name: &str, data: nsh_core::JsonValue);
    /// Complete an embedding host call.
    fn host_reply(&self, id: u64, result: Result<nsh_core::JsonValue, String>);
    /// The reason the host stopped, if it did.
    fn fatal(&self) -> Option<String>;
    /// Stop the host and cancel pending callbacks and promises.
    fn stop(&self, reason: String);
}

thread_local! {
    static NEXT: RefCell<Option<Rc<dyn Host>>> = RefCell::new(None);
}

/// A registration for the immediately following local-engine startup.
/// Dropping it also clears a registration that startup did not consume.
#[derive(Default)]
#[non_exhaustive]
pub struct Registration(Option<Rc<dyn Host>>);
impl Drop for Registration {
    fn drop(&mut self) {
        let Some(host) = &self.0 else {
            return;
        };
        NEXT.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot
                .as_ref()
                .is_some_and(|pending| Rc::ptr_eq(pending, host))
            {
                slot.take();
            }
        });
    }
}

/// Supply the browser host for one `LocalEngine::start` on this thread.
/// A second registration before startup is an error, never a replacement.
pub fn register(host: Rc<dyn Host>) -> Result<Registration, String> {
    NEXT.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_some() {
            return Err("a browser host is already awaiting startup".into());
        }
        *slot = Some(host.clone());
        Ok(Registration(Some(host)))
    })
}

pub(crate) struct Script(Rc<dyn Host>);
impl Drop for Script {
    fn drop(&mut self) {
        self.0.stop("the app was disposed".into());
    }
}
impl Script {
    #[allow(
        clippy::too_many_arguments,
        reason = "same startup boundary as the native host"
    )]
    pub(crate) fn start<M: TextEngine + 'static>(
        bundle: &Bundle,
        _limits: Limits,
        sets: &[Registry],
        posts: Posts,
        environment: &Environment,
        tokens: Arc<Tokens>,
        theme: ThemeTokens,
        _text: Rc<M>,
        _stop: Arc<AtomicBool>,
        sink: Rc<dyn MountSink>,
        system: SystemConfig,
    ) -> Option<(Self, u128)> {
        let result: Result<(Self, u128), String> = (|| {
            if matches!(bundle.code, BundleCode::Bytecode(_)) {
                return Err("the browser JavaScript host cannot execute QuickJS bytecode".into());
            }
            let host = NEXT
                .with(|slot| slot.borrow_mut().take())
                .ok_or_else(|| "no browser JavaScript host was registered".to_owned())?;
            let script = Self(host);
            let services = nsh_core::element::System::new(
                Arc::new(system.access),
                system.data_dir,
                system.paths,
                Default::default(),
            )
            .with_websocket(system.websocket)
            .with_filesystem(system.filesystem)
            .with_os(environment.os);
            script.0.initialize(Services {
                system: services,
                host: system.host,
                wake: system.wake,
                registries: sets.to_vec(),
                posts,
                environment: *environment,
                tokens,
                theme,
            })?;
            Ok((script, 0))
        })();
        match result {
            Ok(value) => Some(value),
            Err(message) => {
                sink.report(&AppError::new(AppErrorKind::Load, &message));
                None
            }
        }
    }
    pub(crate) fn report(
        &self,
        sink: &dyn MountSink,
        kind: AppErrorKind,
        what: &str,
        message: &str,
    ) {
        sink.report(&AppError::new(kind, &format!("{what}: {message}")));
    }
    pub(crate) fn chunk(&self, _: Result<Chunk, (String, String)>) {}
    pub(crate) fn take_chunk_requests(&self, _: &mut Vec<String>) {}
    pub(crate) fn hot_update(&self, _: HotUpdate, sink: &dyn MountSink) {
        self.report(
            sink,
            AppErrorKind::Load,
            "hot update",
            "browser modules require a fresh app instance",
        );
    }
    pub(crate) fn dispatch_event(&self, id: NodeId, event: EventKind, payload: &EventPayload) {
        self.0.dispatch_event(id, event, payload);
    }
    pub(crate) fn deliver(&self, event: JsEvent) {
        self.0.deliver(event);
    }
    pub(crate) fn bind_list(&self, list: NodeId, binds: &[(u32, u32)]) {
        self.0.bind_list(list, binds);
    }
    pub(crate) fn host_event(&self, name: &str, data: nsh_core::JsonValue) {
        self.0.host_event(name, data);
    }
    pub(crate) fn host_reply(&self, id: u64, result: Result<nsh_core::JsonValue, String>) {
        self.0.host_reply(id, result);
    }
    pub(crate) fn animations_finished(&self, finished: &[nsh_core::animation::Finished]) {
        self.0.animations_finished(finished);
    }
    pub(crate) fn take_ops(&self, out: &mut Vec<Op>) {
        self.0.take_ops(out);
    }
    pub(crate) fn run_posted(&self) {
        self.0.run_posted();
    }
    pub(crate) fn has_posted(&self) -> bool {
        self.0.has_posted()
    }
    // Browser timers and promise jobs run in the browser event loop. Each
    // callback schedules the local engine; no second timer queue is kept.
    pub(crate) fn next_timer(&self) -> Option<Instant> {
        None
    }
    pub(crate) fn run_timers(&self, _: Instant) {}
    pub(crate) fn run_system(&self) {}
    pub(crate) fn wants_frame(&self) -> bool {
        self.0.wants_frame()
    }
    pub(crate) fn run_frame(&self) {
        self.0.run_frame();
    }
    pub(crate) fn set_environment(&self, value: &Environment) {
        self.0.set_environment(value);
    }
    pub(crate) fn set_tokens(&self, value: Arc<Tokens>) {
        self.0.set_tokens(value);
    }
    pub(crate) fn set_theme_tokens(&self, value: ThemeTokens) {
        self.0.set_theme_tokens(value);
    }
    pub(crate) fn take_fonts(&self, out: &mut Vec<String>) {
        self.0.take_fonts(out);
    }
    pub(crate) fn take_network(&self, _: &mut NetworkQueue) {}
    pub(crate) fn fetch_event(&self, _: u32, _: FetchEvent) {}
    pub(crate) fn collect_garbage(&self) {}
    pub(crate) fn fatal(&self) -> Option<String> {
        self.0.fatal()
    }
    pub(crate) fn stop(&self, reason: String) {
        self.0.stop(reason);
    }
}
