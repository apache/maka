//! The JS side of an engine running a JS app: its VM ([`nsh_js::Host`])
//! and the source maps its stack traces are mapped with. A Rust app has
//! none; without feature `js` the engine cannot make one (the type is
//! uninhabited, so the loop needs no `cfg`).

/// Host-owned permissions, data root and event wakeup for native system modules.
#[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
pub(crate) struct SystemConfig {
    pub(crate) access: nsh_core::access::Access,
    pub(crate) websocket: Option<std::sync::Arc<dyn nsh_core::websocket::WebSocketTransport>>,
    pub(crate) filesystem: Option<std::sync::Arc<dyn nsh_core::filesystem::FileSystem>>,
    pub(crate) data_dir: Option<std::path::PathBuf>,
    pub(crate) paths: nsh_core::access::TrustedPaths,
    pub(crate) wake: std::sync::Arc<dyn Fn() + Send + Sync>,
    /// The embedding app's side of `nsh/host`.
    pub(crate) host: std::rc::Rc<dyn nsh_core::host_channel::HostBridge>,
}

#[cfg(not(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32"))))]
pub(crate) struct SystemConfig;

#[cfg(feature = "js-core")]
pub(crate) use imp::Script;
#[cfg(all(
    not(feature = "js-core"),
    not(all(feature = "browser", target_arch = "wasm32"))
))]
pub(crate) use stub::Script;

#[cfg(all(feature = "browser", target_arch = "wasm32", not(feature = "js-core")))]
pub(crate) use crate::browser::Script;

#[cfg(feature = "js-core")]
mod imp {
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use nsh_core::{EventKind, EventPayload, NodeId, Op, TextEngine, time::Instant};
    use nsh_js::{Host, HostOptions, JsError, NetworkQueue, RequestId};

    use crate::{
        AppError, AppErrorKind, Bundle, BundleCode, Chunk, Environment, FetchEvent, HotUpdate,
        Limits, MountSink, PackageInfo, symbolicate::Symbolicator,
    };

    /// A JS app's VM.
    pub(crate) struct Script {
        host: Host,
        /// An explicit app exit is delivered through the normal platform command path.
        exit_requested: Rc<Cell<bool>>,
        symbolicator: Rc<RefCell<Symbolicator>>,
        /// Set when the engine stops: what JS was running is interrupted
        /// on purpose, which is not the app's error.
        stop: Arc<AtomicBool>,
        /// The package the bundle came from, named in its errors.
        package: Option<Arc<PackageInfo>>,
    }

    impl Script {
        /// Starts a VM for `bundle` and evaluates it (errors go to `sink`);
        /// also the time evaluation took. `None`: the VM did not start.
        /// The JS calls Rust posts queue in `posts` (the core's too).
        #[allow(
            clippy::too_many_arguments,
            reason = "the VM's setup, from the engine's"
        )]
        pub(crate) fn start<M: TextEngine + 'static>(
            bundle: &Bundle,
            limits: Limits,
            ui_sets: &[nsh_core::element::Registry],
            posts: nsh_core::element::Posts,
            environment: &Environment,
            tokens: Arc<nsh_core::element::Tokens>,
            theme: nsh_core::element::ThemeTokens,
            text_engine: Rc<M>,
            stop: Arc<AtomicBool>,
            sink: Rc<dyn MountSink>,
            system: super::SystemConfig,
        ) -> Option<(Script, u128)> {
            let options = HostOptions {
                limits,
                harden: bundle.policy.harden,
                harden_bytecode: bundle.harden_bytecode.clone(),
                ui_sets: ui_sets.to_vec(),
                posts,
                base_url: bundle.base_url.as_deref().map(str::to_owned),
            };
            let mut host = match Host::with_options(options) {
                Ok(host) => host,
                Err(err) => {
                    log::error!("failed to start JS: {err}");
                    sink.report(
                        &AppError::new(AppErrorKind::Load, &err.message)
                            .with_package(bundle.package.clone()),
                    );
                    return None;
                }
            };
            host.set_system_access(system.access, system.data_dir);
            host.set_system_paths(system.paths);
            host.set_websocket_transport(system.websocket);
            host.set_filesystem(system.filesystem);
            host.set_system_wake(system.wake);
            host.set_host_bridge(system.host);
            host.set_stop_flag(stop.clone());
            let exit_requested = Rc::new(Cell::new(false));
            let request = exit_requested.clone();
            host.set_exit_handler(Rc::new(move |_code| request.set(true)));
            let symbolicator = Rc::new(RefCell::new(Symbolicator::new(bundle.source_map.clone())));
            let (map, errors, stopping) = (symbolicator.clone(), sink.clone(), stop.clone());
            let package = bundle.package.clone();
            host.set_error_handler(Box::new(move |err| {
                if stopping.load(Ordering::Relaxed) {
                    return;
                }
                let message = map.borrow_mut().rewrite(&err.message);
                log::error!(target: "js", "uncaught exception: {message}");
                errors.report(
                    &AppError::new(AppErrorKind::Uncaught, &message).with_package(package.clone()),
                );
            }));
            // Unhandled rejections are logged only, as browsers do: the
            // app's error handler and the overlay get exceptions.
            let (map, stopping) = (symbolicator.clone(), stop.clone());
            host.set_rejection_handler(Box::new(move |err| {
                if stopping.load(Ordering::Relaxed) {
                    return;
                }
                let message = map.borrow_mut().rewrite(&err.message);
                log::error!(target: "js", "unhandled rejection: {message}");
            }));
            // Canvas `measureText` measures on this thread.
            host.set_text_measurer(Box::new(move |font, text| {
                nsh_core::canvas::measure_line(&*text_engine, font, text)
            }));
            host.set_environment(environment);
            host.set_tokens(tokens);
            host.set_theme_tokens(theme);
            let script = Script {
                host,
                exit_requested,
                symbolicator,
                stop,
                package: bundle.package.clone(),
            };
            // The chunks that come with the bundle: the entry may import
            // them statically, `import()` without waiting.
            for chunk in bundle.chunks.iter() {
                script.chunk(Ok(chunk.clone()));
            }
            let start = Instant::now();
            let loaded: Result<(), JsError> = match &bundle.code {
                BundleCode::Bytecode(bytes) => script.host.eval_bytecode(bytes),
                BundleCode::Source(code) => script.host.eval_source(code),
            };
            if let Err(err) = loaded {
                script.report(&*sink, AppErrorKind::Load, "bundle failed", &err.message);
            }
            let eval_us = start.elapsed().as_micros();
            Some((script, eval_us))
        }

        /// Reports an error of the app, its stack mapped to the sources.
        pub(crate) fn report(
            &self,
            sink: &dyn MountSink,
            kind: AppErrorKind,
            what: &str,
            message: &str,
        ) {
            if self.stop.load(Ordering::Relaxed) {
                return;
            }
            let message = self.symbolicator.borrow_mut().rewrite(message);
            log::error!(target: "js", "{what}: {message}");
            sink.report(&AppError::new(kind, &message).with_package(self.package.clone()));
        }

        /// Gives the VM a chunk it imports, or tells it the chunk could not
        /// be loaded.
        pub(crate) fn chunk(&self, chunk: Result<Chunk, (String, String)>) {
            match chunk {
                Ok(chunk) => {
                    if let Some(map) = chunk.source_map {
                        self.symbolicator.borrow_mut().add(&chunk.id, map);
                    }
                    match chunk.code {
                        BundleCode::Source(code) => self.host.add_chunk_source(&chunk.id, code),
                        // SAFETY: `Chunk::bytecode` requires trusted bytecode.
                        BundleCode::Bytecode(bytes) => unsafe {
                            self.host.add_chunk_bytecode(&chunk.id, bytes)
                        },
                    }
                }
                Err((id, message)) => self.host.chunk_failed(&id, &message),
            }
        }

        pub(crate) fn take_chunk_requests(&self, out: &mut Vec<String>) {
            self.host.take_chunk_requests(out);
        }

        /// Applies a development update in place.
        pub(crate) fn hot_update(&self, update: HotUpdate, sink: &dyn MountSink) {
            if let Some(map) = update.source_map {
                self.symbolicator.borrow_mut().add(&update.name, map);
            }
            let start = Instant::now();
            match self.host.eval_script(&update.name, &update.code) {
                Ok(true) => log::info!("hot update applied in {}µs", start.elapsed().as_micros()),
                Ok(false) => sink.hot_update_failed(),
                // The app keeps the modules that ran; the next update can
                // fix the rest.
                Err(err) => self.report(
                    sink,
                    AppErrorKind::HotUpdate,
                    "hot update failed",
                    &err.message,
                ),
            }
        }

        pub(crate) fn dispatch_event(&self, id: NodeId, event: EventKind, payload: &EventPayload) {
            self.host.dispatch_event(id, event, payload);
        }

        pub(crate) fn deliver(&self, event: nsh_core::element::JsEvent) {
            self.host.deliver(event);
        }

        pub(crate) fn cancel_touch(&self, contact: u32) {
            self.host.cancel_touch(contact);
        }

        pub(crate) fn invalid_touch_contacts(
            &self,
            accepts: impl FnMut(NodeId) -> bool,
            contacts: &mut Vec<u32>,
        ) {
            self.host.invalid_touch_contacts(accepts, contacts);
        }

        pub(crate) fn bind_list(&self, list: NodeId, binds: &[(u32, u32)]) {
            self.host.bind_list(list, binds);
        }

        pub(crate) fn host_event(&self, name: &str, data: nsh_core::JsonValue) {
            self.host.host_event(name, data);
        }

        pub(crate) fn host_reply(&self, id: u64, result: Result<nsh_core::JsonValue, String>) {
            self.host.host_reply(id, result);
        }

        pub(crate) fn animations_finished(&self, finished: &[nsh_core::animation::Finished]) {
            self.host.animations_finished(finished);
        }

        pub(crate) fn take_ops(&self, out: &mut Vec<Op>) {
            self.host.take_ops(out);
            if self.exit_requested.replace(false) {
                out.push(Op::Command {
                    id: nsh_core::ROOT_ID,
                    command: nsh_core::Command::ExitApp,
                });
            }
        }

        pub(crate) fn run_posted(&self) {
            self.host.run_posted();
        }

        pub(crate) fn has_posted(&self) -> bool {
            self.host.has_posted()
        }

        pub(crate) fn next_timer(&self) -> Option<Instant> {
            self.host.next_timer()
        }

        pub(crate) fn run_timers(&self, now: Instant) {
            self.host.run_timers(now);
        }

        pub(crate) fn run_system(&self) {
            self.host.run_system();
        }

        pub(crate) fn wants_frame(&self) -> bool {
            self.host.wants_frame()
        }

        pub(crate) fn run_frame(&self) {
            self.host.run_frame();
        }

        pub(crate) fn set_environment(&self, environment: &Environment) {
            self.host.set_environment(environment);
        }

        pub(crate) fn set_focus_path(&self, path: &[NodeId]) {
            self.host.set_focus_path(path);
        }

        pub(crate) fn set_tokens(&self, tokens: Arc<nsh_core::element::Tokens>) {
            self.host.set_tokens(tokens);
        }

        pub(crate) fn set_theme_tokens(&self, theme: nsh_core::element::ThemeTokens) {
            self.host.set_theme_tokens(theme);
        }

        pub(crate) fn take_fonts(&self, out: &mut Vec<String>) {
            self.host.take_fonts(out);
        }

        pub(crate) fn take_network(&self, out: &mut NetworkQueue) {
            self.host.take_network(out);
        }

        pub(crate) fn fetch_event(&self, id: RequestId, event: FetchEvent) {
            self.host.fetch_event(id, event);
        }

        pub(crate) fn collect_garbage(&self) {
            self.host.collect_garbage();
        }

        pub(crate) fn fatal(&self) -> Option<String> {
            self.host.fatal()
        }

        pub(crate) fn stop(&self, reason: String) {
            self.host.stop(reason);
        }
    }
}

#[cfg(not(feature = "js-core"))]
mod stub {
    #[cfg(not(all(feature = "browser", target_arch = "wasm32")))]
    use std::{
        rc::Rc,
        sync::{Arc, atomic::AtomicBool},
    };

    #[cfg(not(all(feature = "browser", target_arch = "wasm32")))]
    use nsh_core::{EventKind, EventPayload, NodeId, Op, TextEngine, time::Instant};

    #[cfg(not(all(feature = "browser", target_arch = "wasm32")))]
    use crate::{AppError, AppErrorKind, Bundle, Chunk, Environment, HotUpdate, Limits, MountSink};

    /// No JS in this build: never made.
    #[cfg(not(all(feature = "browser", target_arch = "wasm32")))]
    pub(crate) enum Script {}

    /// What JS asked of its requests (nothing without JS).
    #[derive(Default)]
    pub(crate) struct NetworkQueue {
        pub(crate) ops: Vec<(u32, crate::FetchOp)>,
    }

    #[cfg(not(all(feature = "browser", target_arch = "wasm32")))]
    impl Script {
        #[allow(clippy::too_many_arguments, reason = "as the real one's")]
        pub(crate) fn start<M: TextEngine + 'static>(
            _: &Bundle,
            _: Limits,
            _: &[nsh_core::element::Registry],
            _: nsh_core::element::Posts,
            _: &Environment,
            _: Arc<nsh_core::element::Tokens>,
            _: nsh_core::element::ThemeTokens,
            _: Rc<M>,
            _: Arc<AtomicBool>,
            sink: Rc<dyn MountSink>,
            _: super::SystemConfig,
        ) -> Option<(Script, u128)> {
            let message = "this build of nsh runs Rust apps only (feature `js` is off)";
            log::error!("{message}");
            sink.report(&AppError::new(AppErrorKind::Load, message));
            None
        }

        pub(crate) fn report(&self, _: &dyn MountSink, _: AppErrorKind, _: &str, _: &str) {
            match *self {}
        }

        pub(crate) fn hot_update(&self, _: HotUpdate, _: &dyn MountSink) {
            match *self {}
        }

        pub(crate) fn chunk(&self, _: Result<Chunk, (String, String)>) {
            match *self {}
        }

        pub(crate) fn take_chunk_requests(&self, _: &mut Vec<String>) {
            match *self {}
        }

        pub(crate) fn dispatch_event(&self, _: NodeId, _: EventKind, _: &EventPayload) {
            match *self {}
        }

        pub(crate) fn deliver(&self, _: nsh_core::element::JsEvent) {
            match *self {}
        }

        pub(crate) fn cancel_touch(&self, _: u32) {
            match *self {}
        }

        pub(crate) fn invalid_touch_contacts(
            &self,
            _: impl FnMut(NodeId) -> bool,
            _: &mut Vec<u32>,
        ) {
            match *self {}
        }

        pub(crate) fn bind_list(&self, _: NodeId, _: &[(u32, u32)]) {
            match *self {}
        }

        pub(crate) fn host_event(&self, _: &str, _: nsh_core::JsonValue) {
            match *self {}
        }

        pub(crate) fn host_reply(&self, _: u64, _: Result<nsh_core::JsonValue, String>) {
            match *self {}
        }

        pub(crate) fn animations_finished(&self, _: &[nsh_core::animation::Finished]) {
            match *self {}
        }

        pub(crate) fn take_ops(&self, _: &mut Vec<Op>) {
            match *self {}
        }

        pub(crate) fn run_posted(&self) {
            match *self {}
        }

        pub(crate) fn has_posted(&self) -> bool {
            match *self {}
        }

        pub(crate) fn next_timer(&self) -> Option<Instant> {
            match *self {}
        }

        pub(crate) fn run_timers(&self, _: Instant) {
            match *self {}
        }

        pub(crate) fn run_system(&self) {
            match *self {}
        }

        pub(crate) fn wants_frame(&self) -> bool {
            match *self {}
        }

        pub(crate) fn run_frame(&self) {
            match *self {}
        }

        pub(crate) fn set_environment(&self, _: &Environment) {
            match *self {}
        }

        pub(crate) fn set_focus_path(&self, _: &[NodeId]) {
            match *self {}
        }

        pub(crate) fn set_tokens(&self, _: Arc<nsh_core::element::Tokens>) {
            match *self {}
        }

        pub(crate) fn set_theme_tokens(&self, _: nsh_core::element::ThemeTokens) {
            match *self {}
        }

        pub(crate) fn take_fonts(&self, _: &mut Vec<String>) {
            match *self {}
        }

        pub(crate) fn take_network(&self, _: &mut NetworkQueue) {
            match *self {}
        }

        pub(crate) fn fetch_event(&self, _: u32, _: crate::FetchEvent) {
            match *self {}
        }

        pub(crate) fn collect_garbage(&self) {
            match *self {}
        }

        pub(crate) fn fatal(&self) -> Option<String> {
            match *self {}
        }

        pub(crate) fn stop(&self, _: String) {
            match *self {}
        }
    }
}

#[cfg(feature = "js-core")]
pub(crate) use nsh_js::{NetworkQueue, RequestId};
#[cfg(not(feature = "js-core"))]
pub(crate) use stub::NetworkQueue;
/// Identifies a request between JS and the network stack.
#[cfg(not(feature = "js-core"))]
pub(crate) type RequestId = u32;
