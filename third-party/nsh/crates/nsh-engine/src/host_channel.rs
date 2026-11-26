//! [`HostChannel`]: the embedding app's side of the message channel with
//! the app a surface runs (`nsh/host`; `nsh_core::host_channel`).
//!
//! A platform's view (`AppView`, `NshAppView`, `NshView`) keeps one channel
//! for every app it runs and hands it to each engine
//! ([`crate::EngineConfig::host`]). The engine attaches to it while it
//! runs: [`HostChannel::send`] queues the event on that engine (kept for
//! the next app while none runs), and the app's calls and posts reach the
//! handlers registered with [`HostChannel::handle`]. Handlers run on the
//! engine thread and must not block it: they answer at once or move the
//! [`HostCall`] (or its [`HostReply`]) to another thread and answer from
//! there. The SDKs' handlers (Swift, Java) run on the main thread: their
//! glue hops there.
//!
//! The channel also carries the embedding app's URL handler
//! ([`HostChannel::handle_open_url`]): the URLs the app opens (`openUrl` of
//! `nsh/device`) reach it before the system, so a host routes them through
//! its own router. It is a typed hook of the channel rather than a named
//! message: it takes only what passed the URL check and the `openUrl`
//! capability, and no app's `host.call` name can reach it.
//!
//! A handler that answers over time (progress of a sign-in, a long
//! request) sends its events to the app that made the call alone with the
//! call's [`HostCall::sender`]: once that app stops or another takes the
//! view, they go nowhere instead of to the next app, and
//! [`HostSender::closed`] tells the handler to stop.

use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
};

use crossbeam_channel::{Receiver, Sender};
#[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
use nsh_core::host_channel::HostBridge;
use nsh_core::{
    JsonValue,
    host_channel::{HostError, HostInbox, HostRequest, ModuleFake, check_name},
};

use crate::Message;

/// A handler of the app's calls and posts of one name.
type Handler = Arc<dyn Fn(HostCall) + Send + Sync>;

/// Runs `handler` with `call`; a handler that panics drops the call, which
/// fails it in the app.
fn run_handler(handler: &Handler, call: HostCall) {
    let name = call.name.clone();
    let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(call)));
    if ran.is_err() {
        log::error!("nsh/host: the embedding app's handler of \"{name}\" panicked");
    }
}

/// Why [`HostChannel::start_request`] did not hand a request to a handler.
pub(crate) enum HostRefusal {
    /// The channel is not configured: the platform's host takes it.
    Unconfigured(HostRequest),
    /// No handler of the call's name: the call (its id) fails so.
    NoHandler(u64, HostError),
}

/// The embedding app's handler of the URLs the app opens.
type UrlHandler = Arc<dyn Fn(OpenUrlRequest) + Send + Sync>;

/// The embedding app's side of the channel with the apps one of its views
/// runs: launch parameters, events to the app (`host.on` in TSX), and
/// handlers of the app's calls (`host.call`) and posts (`host.post`).
///
/// Cheap to clone (the clones are one channel); usable from any thread.
/// One per view, shared by the apps it runs one after another.
///
/// ```
/// use nsh_engine::{HostChannel, JsonValue};
///
/// let channel = HostChannel::new();
/// // What the next app reads synchronously at start (`host.params`).
/// let mut params = serde_json::Map::new();
/// params.insert("conversation".into(), JsonValue::from("c-42"));
/// channel.set_params(params);
/// // `await host.call("profile", { id })` in the app.
/// channel.handle("profile", |call| {
///     let id = call.data()["id"].clone();
///     call.resolve(serde_json::json!({ "id": id, "name": "Ada" }));
/// });
/// // `host.on("user.changed", ...)` in the app.
/// channel.send("user.changed", serde_json::json!({ "id": 7 })).unwrap();
/// ```
#[derive(Clone, Default)]
pub struct HostChannel {
    inner: Arc<Mutex<Inner>>,
    /// The app's calls handed to a handler and not yet answered, and
    /// those answered.
    calls: Arc<CallCount>,
}

/// A channel's count of the calls its handlers took ([`HostReply`]).
#[derive(Default)]
struct CallCount {
    /// Taken and not yet answered.
    in_flight: AtomicUsize,
    /// Answered so far: counted before the call leaves `in_flight`, so a
    /// reader that saw none in flight sees every answer that came.
    answered: AtomicU64,
}

#[derive(Default)]
struct Inner {
    params: serde_json::Map<String, JsonValue>,
    configured: bool,
    handlers: HashMap<String, Handler>,
    url_handler: Option<UrlHandler>,
    /// The engine running the view's app: its attachment's id, and its
    /// queue as the calls it makes see it ([`HostCall::sender`]).
    engine: Option<(u64, Arc<Caller>)>,
    next_engine: u64,
    /// Events sent while no app ran, for the next one.
    pending: HostInbox,
    /// The stand-ins for native modules' exports: specifier, export (or
    /// `Export.member`), stand-in.
    module_fakes: Vec<(String, String, ModuleFake)>,
    /// The handlers of the stand-ins' calls, apart from the embedding
    /// app's: they configure nothing and `host.call` never reaches them.
    fake_handlers: HashMap<String, Handler>,
}

impl std::fmt::Debug for HostChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.lock();
        let mut handlers: Vec<&String> = inner.handlers.keys().collect();
        handlers.sort();
        f.debug_struct("HostChannel")
            .field("params", &inner.params)
            .field("handlers", &handlers)
            .field("configured", &inner.configured)
            .field("url_handler", &inner.url_handler.is_some())
            .field("attached", &inner.engine.is_some())
            .field("pending", &inner.pending.len())
            .finish()
    }
}

impl HostChannel {
    /// A channel with no parameters and no handlers.
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// How many of the apps' calls a handler has and has not answered yet.
    /// A headless test driver waits for them before it ends a step: their
    /// answer comes from another thread, in real time.
    #[doc(hidden)]
    pub fn calls_in_flight(&self) -> usize {
        self.calls.in_flight.load(Ordering::SeqCst)
    }

    /// How many of the apps' calls a handler has answered so far. An
    /// answer is on the engine's queue once counted, and may land after
    /// the engine said it was idle: a headless test driver that read this
    /// before asking, and finds no call in flight and this count changed,
    /// asks again ([`HostChannel::calls_in_flight`] first, then this).
    #[doc(hidden)]
    pub fn calls_answered(&self) -> u64 {
        self.calls.answered.load(Ordering::SeqCst)
    }

    /// The launch parameters of the apps started from now on
    /// (`host.params`, read synchronously when they start; a running app
    /// keeps the ones it started with). Later requests are events
    /// ([`HostChannel::send`]).
    ///
    /// Parameters alone answer no call, so they leave the channel as it
    /// was: until a handler ([`HostChannel::handle`]) or an event
    /// configures it, the app's calls keep going to the platform's own
    /// host, as on the web, where the page passes parameters and answers
    /// calls with its player's host.
    pub fn set_params(&self, params: serde_json::Map<String, JsonValue>) {
        self.lock().params = params;
    }

    /// The launch parameters ([`HostChannel::set_params`]).
    pub fn params(&self) -> serde_json::Map<String, JsonValue> {
        self.lock().params.clone()
    }

    /// Sends event `name` with `data` to the running app (`host.on(name,
    /// listener)`, Rust's `on_host_event`). The app keeps events of names
    /// it does not listen to yet until it does; while no app runs, events
    /// wait for the next one
    /// (up to [`nsh_core::host_channel::MAX_QUEUED_EVENTS`] each, then the
    /// oldest go). Any thread; it never waits for the app. `Err` for a name
    /// that is empty or longer than
    /// [`nsh_core::host_channel::MAX_NAME_LEN`] bytes.
    pub fn send(&self, name: impl Into<String>, data: JsonValue) -> Result<(), String> {
        let name = name.into();
        check_name(&name)?;
        let mut inner = self.lock();
        inner.configured = true;
        if let Some((_, engine)) = &inner.engine
            && engine
                .tx
                .send(Message::HostEvent(name.clone(), data.clone()))
                .is_ok()
        {
            return Ok(());
        }
        if let Some((dropped, _)) = inner.pending.push(name, data) {
            log::warn!(
                "nsh/host: no app ran to take the embedding app's events; the oldest (\"{dropped}\") was dropped"
            );
        }
        Ok(())
    }

    /// Handles the app's calls (`host.call(name, data)`) and posts
    /// (`host.post(name, data)`) of `name`, replacing the handler it had.
    /// `handler` runs on the engine thread and must return quickly: it
    /// answers a call with [`HostCall::resolve`] / [`HostCall::reject`] at
    /// once, or moves the call to where its answer comes from and answers
    /// there, from any thread. A post's answer goes nowhere. A call that
    /// is dropped unanswered fails in the app.
    pub fn handle(
        &self,
        name: impl Into<String>,
        handler: impl Fn(HostCall) + Send + Sync + 'static,
    ) {
        let mut inner = self.lock();
        inner.configured = true;
        inner.handlers.insert(name.into(), Arc::new(handler));
    }

    /// Removes the handler of `name`: the app's calls of it fail at once
    /// from now on, its posts are dropped.
    pub fn remove_handler(&self, name: &str) {
        self.lock().handlers.remove(name);
    }

    /// Puts `fake` in the place of export `path` of native module
    /// `specifier` (`"Keychain"`, or a member of an export,
    /// `"Keychain.get"`) in the apps started from now on, as `nsh test`'s
    /// `open` does for the app a test opens: their imports of the module
    /// get the stand-in. A [`ModuleFake::Call`] is answered by the
    /// handler of its name [`HostChannel::handle_module_fake`] registers.
    /// `nsh test`'s hook, not part of the embedding API.
    #[doc(hidden)]
    pub fn fake_module_export(
        &self,
        specifier: impl Into<String>,
        path: impl Into<String>,
        fake: ModuleFake,
    ) {
        self.lock()
            .module_fakes
            .push((specifier.into(), path.into(), fake));
    }

    /// Handles the calls of the stand-ins whose [`ModuleFake::Call`] is
    /// `name`, as [`HostChannel::handle`] does the app's `host.call`s, but
    /// apart from them: the app's `host.call` never reaches it, and the
    /// channel stays as the embedding app configured it (`host.available()`).
    /// `nsh test`'s hook, not part of the embedding API.
    #[doc(hidden)]
    pub fn handle_module_fake(
        &self,
        name: impl Into<String>,
        handler: impl Fn(HostCall) + Send + Sync + 'static,
    ) {
        self.lock()
            .fake_handlers
            .insert(name.into(), Arc::new(handler));
    }

    #[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
    fn handler(&self, name: &str) -> Option<Handler> {
        self.lock().handlers.get(name).cloned()
    }

    #[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
    fn fake_handler(&self, name: &str) -> Option<Handler> {
        self.lock().fake_handlers.get(name).cloned()
    }

    /// Hands a call or post of the core (the app's Rust, or JS's without
    /// a channel of its own) to the handler of its name, answered back to
    /// the core through `tx` (`Message::CoreHostReply`). Without handlers
    /// or events the channel is not configured: the request comes back for
    /// the platform's host. A configured channel without a handler of the
    /// name fails the call at once and drops the post, as it does JS's.
    pub(crate) fn start_request(
        &self,
        request: HostRequest,
        tx: &Sender<Message>,
    ) -> Result<(), HostRefusal> {
        let (handler, configured) = {
            let inner = self.lock();
            let name = match &request {
                HostRequest::Call { name, .. } | HostRequest::Post { name, .. } => name,
                _ => return Err(HostRefusal::Unconfigured(request)),
            };
            (inner.handlers.get(name).cloned(), inner.configured)
        };
        if !configured {
            return Err(HostRefusal::Unconfigured(request));
        }
        match request {
            HostRequest::Call { id, name, args } => {
                let Some(handler) = handler else {
                    return Err(HostRefusal::NoHandler(
                        id,
                        HostError::Failed(format!(
                            "host.call(\"{name}\"): the embedding app handles no \"{name}\""
                        )),
                    ));
                };
                self.calls.in_flight.fetch_add(1, Ordering::SeqCst);
                let reply = HostReply {
                    id,
                    name: name.clone(),
                    tx: Some(tx.clone()),
                    calls: Some(self.calls.clone()),
                    to_core: true,
                };
                run_handler(
                    &handler,
                    HostCall {
                        name,
                        data: args,
                        reply: Some(reply),
                        caller: self.caller(tx),
                    },
                );
            }
            HostRequest::Post { name, args } => match handler {
                Some(handler) => run_handler(
                    &handler,
                    HostCall {
                        name,
                        data: args,
                        reply: None,
                        caller: self.caller(tx),
                    },
                ),
                None => log::debug!(
                    "nsh/host: the embedding app handles no \"{name}\"; the post was dropped"
                ),
            },
            _ => {}
        }
        Ok(())
    }

    /// Asks the engine to stop without interrupting JS, so its quit
    /// listeners run ([`HostChannel::shutdown`] follows): events sent
    /// meanwhile follow the shutdown message, kept for the next app.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn request_shutdown(&self, tx: &Sender<Message>) {
        let caller = {
            let inner = self.lock();
            let _ = tx.send(Message::Shutdown);
            self.caller_locked(&inner, tx)
        };
        // The app is leaving: its calls' senders close.
        if let Some(caller) = caller {
            caller.close();
        }
    }

    /// Events sent once JS is interrupted must follow the shutdown
    /// message, so the attachment can recover them for the next app.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn shutdown(&self, tx: &Sender<Message>, stop: &std::sync::atomic::AtomicBool) {
        let caller = {
            let inner = self.lock();
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = tx.send(Message::Shutdown);
            self.caller_locked(&inner, tx)
        };
        if let Some(caller) = caller {
            caller.close();
        }
    }

    /// The attached engine as the calls of the engine whose queue is `tx`
    /// see it: `None` (their senders closed) when another engine runs the
    /// view, or none does.
    fn caller(&self, tx: &Sender<Message>) -> Option<Arc<Caller>> {
        self.caller_locked(&self.lock(), tx)
    }

    fn caller_locked(&self, inner: &Inner, tx: &Sender<Message>) -> Option<Arc<Caller>> {
        inner
            .engine
            .as_ref()
            .filter(|(_, engine)| engine.tx.same_channel(tx) && !engine.is_closed())
            .map(|(_, engine)| engine.clone())
    }

    /// Takes the URLs the app opens (`openUrl` of `nsh/device`, a
    /// `TextView`'s links) before the system does, replacing the handler
    /// it had: a host routes them through its own router. The URL passed
    /// the URL check and the app's `openUrl` capability
    /// ([`nsh_core::open_url`]). `handler` runs on the engine thread and
    /// must return quickly: it answers with [`OpenUrlRequest::handled`]
    /// (the app's `openUrl` resolves `true`) or
    /// [`OpenUrlRequest::decline`] (the system opens it), at once or from
    /// any thread later. A request dropped unanswered is declined.
    pub fn handle_open_url(&self, handler: impl Fn(OpenUrlRequest) + Send + Sync + 'static) {
        self.lock().url_handler = Some(Arc::new(handler));
    }

    /// Removes the URL handler: the system opens the app's URLs from now
    /// on.
    pub fn remove_open_url_handler(&self) {
        self.lock().url_handler = None;
    }

    /// Hands URL request `id` of the engine whose queue is `tx` to the
    /// embedding app's URL handler; without one, `None`: the system opens
    /// it.
    pub(crate) fn open_url(&self, id: u32, url: String, tx: &Sender<Message>) -> Option<()> {
        let handler = self.lock().url_handler.clone()?;
        let request = OpenUrlRequest {
            reply: Some(UrlReply {
                id,
                url: url.clone(),
                tx: tx.clone(),
            }),
            url,
        };
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(request))).is_err() {
            log::error!("nsh/device: the embedding app's URL handler panicked");
        }
        Some(())
    }

    /// Attaches the engine whose queue is `tx`: events go to it from now
    /// on, those waiting first. Detached when the attachment drops (unless
    /// another engine attached since).
    pub(crate) fn attach(&self, tx: Sender<Message>, rx: Receiver<Message>) -> HostAttachment {
        let (id, replaced) = {
            let mut inner = self.lock();
            inner.next_engine += 1;
            let id = inner.next_engine;
            for (name, data) in inner.pending.take_all() {
                let _ = tx.send(Message::HostEvent(name, data));
            }
            let replaced = inner.engine.replace((id, Arc::new(Caller::new(tx))));
            (id, replaced)
        };
        // The engine this one replaces no longer gets its calls' events.
        if let Some((_, engine)) = replaced {
            engine.close();
        }
        HostAttachment {
            channel: self.clone(),
            id,
            rx,
        }
    }

    /// The bridge an app's `nsh/host` reaches this channel through, from
    /// the engine whose queue is `tx`: its parameters and module stand-ins
    /// as they are now.
    #[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
    pub(crate) fn bridge(&self, tx: Sender<Message>) -> EngineBridge {
        let inner = self.lock();
        EngineBridge {
            params: JsonValue::Object(inner.params.clone()),
            module_fakes: inner.module_fakes.clone(),
            channel: self.clone(),
            tx,
        }
    }
}

/// An engine's attachment to its view's channel ([`HostChannel::attach`]).
pub(crate) struct HostAttachment {
    channel: HostChannel,
    id: u64,
    /// Events behind a shutdown message still belong to this channel.
    rx: Receiver<Message>,
}

impl Drop for HostAttachment {
    fn drop(&mut self) {
        let (discarded, engine) = {
            let mut inner = self.channel.lock();
            if !inner.engine.as_ref().is_some_and(|(id, _)| *id == self.id) {
                return;
            }
            let engine = inner.engine.take();
            // Detach and drain under the same lock as `send`: every event
            // either waits here or is kept by `send` for the next app. The
            // events of its calls' senders (`Message::CallerEvent`) were for
            // this app alone: they go with the rest.
            let mut messages: Vec<_> = self.rx.try_iter().collect();
            for message in &mut messages {
                if let Message::HostEvent(name, data) = message
                    && let Some((dropped, _)) = inner
                        .pending
                        .push(std::mem::take(name), std::mem::take(data))
                {
                    log::warn!(
                        "nsh/host: the app stopped; the oldest kept event (\"{dropped}\") was dropped"
                    );
                }
            }
            (messages, engine)
        };
        if let Some((_, engine)) = engine {
            engine.close();
        }
        // Other messages can own closures whose destructors reach the
        // channel. Release them without its lock held.
        drop(discarded);
    }
}

/// What an engine's `nsh/host` reaches of the channel
/// ([`nsh_core::host_channel::HostBridge`]).
#[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
pub(crate) struct EngineBridge {
    params: JsonValue,
    // A copy, so making a module's exports takes no lock.
    module_fakes: Vec<(String, String, ModuleFake)>,
    channel: HostChannel,
    tx: Sender<Message>,
}

#[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
impl EngineBridge {
    /// Runs `handler` with call `id` of `name`, answered back to this
    /// engine.
    fn start(&self, handler: &Handler, id: u64, name: &str, data: JsonValue) {
        let calls = self.channel.calls.clone();
        calls.in_flight.fetch_add(1, Ordering::SeqCst);
        let call = HostCall {
            name: name.to_owned(),
            data,
            reply: Some(HostReply {
                id,
                name: name.to_owned(),
                tx: Some(self.tx.clone()),
                calls: Some(calls),
                to_core: false,
            }),
            caller: self.channel.caller(&self.tx),
        };
        run_handler(handler, call);
    }
}

#[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
impl HostBridge for EngineBridge {
    fn available(&self) -> bool {
        self.channel.lock().configured
    }

    fn params(&self) -> JsonValue {
        self.params.clone()
    }

    fn call(&self, id: u64, name: &str, data: JsonValue) -> Result<(), String> {
        let Some(handler) = self.channel.handler(name) else {
            return Err(format!(
                "host.call(\"{name}\"): the embedding app handles no \"{name}\""
            ));
        };
        self.start(&handler, id, name, data);
        Ok(())
    }

    fn module_fakes(&self, specifier: &str) -> Vec<(String, ModuleFake)> {
        self.module_fakes
            .iter()
            .filter(|(s, _, _)| s == specifier)
            .map(|(_, path, fake)| (path.clone(), fake.clone()))
            .collect()
    }

    fn call_module_fake(&self, id: u64, name: &str, data: JsonValue) -> Result<(), String> {
        let Some(handler) = self.channel.fake_handler(name) else {
            return Err(format!("no stand-in answers \"{name}\""));
        };
        self.start(&handler, id, name, data);
        Ok(())
    }

    fn post(&self, name: &str, data: JsonValue) {
        match self.channel.handler(name) {
            Some(handler) => run_handler(
                &handler,
                HostCall {
                    name: name.to_owned(),
                    data,
                    reply: None,
                    caller: self.channel.caller(&self.tx),
                },
            ),
            None => log::debug!(
                "nsh/host: the embedding app handles no \"{name}\"; the post was dropped"
            ),
        }
    }
}

/// A call (`host.call(name, data)`) or a post (`host.post(name, data)`) of
/// the app, as the embedding app's handler gets it. A call is answered once,
/// from any thread; dropped unanswered, it fails in the app.
#[derive(Default)]
#[non_exhaustive]
pub struct HostCall {
    name: String,
    data: JsonValue,
    reply: Option<HostReply>,
    /// The engine that made it, while it ran the view when it did.
    caller: Option<Arc<Caller>>,
}

impl std::fmt::Debug for HostCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostCall")
            .field("name", &self.name)
            .field("data", &self.data)
            .field("post", &self.is_post())
            .finish()
    }
}

impl HostCall {
    /// Its name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Its data (`null` when the app sent none).
    pub fn data(&self) -> &JsonValue {
        &self.data
    }

    /// Takes its data, leaving `null`.
    pub fn take_data(&mut self) -> JsonValue {
        std::mem::take(&mut self.data)
    }

    /// Whether it is a post, whose answer goes nowhere.
    pub fn is_post(&self) -> bool {
        self.reply.is_none()
    }

    /// Answers the call: the app's promise resolves with `value`.
    pub fn resolve(self, value: JsonValue) {
        self.reply(Ok(value));
    }

    /// Fails the call: the app's promise rejects with an `Error` of
    /// `message`.
    pub fn reject(self, message: impl Into<String>) {
        self.reply(Err(message.into()));
    }

    /// Answers the call with `result` ([`HostCall::resolve`],
    /// [`HostCall::reject`]).
    pub fn reply(mut self, result: Result<JsonValue, String>) {
        if let Some(reply) = self.reply.take() {
            reply.reply(result);
        }
    }

    /// The reply alone, to answer from elsewhere (`None` for a post).
    pub fn into_reply(mut self) -> Option<HostReply> {
        self.reply.take()
    }

    /// Sends events to the app that made this call or post alone, as
    /// [`HostChannel::send`] does to the running app: for progress while a
    /// handler answers over time. Once that app stops, or another app
    /// takes the view (a reload), the sender closes: its events go nowhere
    /// rather than to the next app, and [`HostSender::closed`] resolves so
    /// the handler can stop its work. Take it before
    /// [`HostCall::into_reply`]; it outlives the call.
    pub fn sender(&self) -> HostSender {
        HostSender {
            caller: self.caller.clone(),
        }
    }
}

/// An engine's queue as the calls it makes see it: open while it runs the
/// view ([`HostCall::sender`]).
struct Caller {
    tx: Sender<Message>,
    closed: AtomicBool,
    /// The [`HostSenderClosed`] futures waiting, by id, and the next id.
    waiting: Mutex<(u64, HashMap<u64, Waker>)>,
}

impl Caller {
    fn new(tx: Sender<Message>) -> Self {
        Self {
            tx,
            closed: AtomicBool::new(false),
            waiting: Mutex::default(),
        }
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn waiting(&self) -> MutexGuard<'_, (u64, HashMap<u64, Waker>)> {
        self.waiting.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Closes the senders of its calls and wakes those waiting on it, once.
    fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let wakers = std::mem::take(&mut self.waiting().1);
        for (_, waker) in wakers {
            waker.wake();
        }
    }
}

/// Sends events to the app that made one call or post
/// ([`HostCall::sender`]). Cheap to clone; usable from any thread.
#[derive(Clone, Default)]
pub struct HostSender {
    /// `None` when the app had already stopped or been replaced when it
    /// made the call (and for a [`HostCall`] made by hand).
    caller: Option<Arc<Caller>>,
}

impl std::fmt::Debug for HostSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostSender")
            .field("closed", &self.is_closed())
            .finish()
    }
}

impl HostSender {
    /// Sends event `name` with `data` to the app that made the call
    /// (`host.on(name, listener)`, as [`HostChannel::send`]). `Ok(false)`
    /// once that app stopped or another took the view: the event is
    /// dropped, never kept for the next app. `Ok(true)` puts it on the
    /// app's queue; an app that stops before it reads the event drops it.
    /// `Err` for a name that is empty or longer than
    /// [`nsh_core::host_channel::MAX_NAME_LEN`] bytes.
    pub fn send(&self, name: impl Into<String>, data: JsonValue) -> Result<bool, String> {
        let name = name.into();
        check_name(&name)?;
        let Some(caller) = self.caller.as_ref().filter(|c| !c.is_closed()) else {
            return Ok(false);
        };
        Ok(caller.tx.send(Message::CallerEvent(name, data)).is_ok())
    }

    /// Whether the app that made the call stopped or was replaced: its
    /// events go nowhere from now on.
    pub fn is_closed(&self) -> bool {
        self.caller.as_ref().is_none_or(|c| c.is_closed())
    }

    /// Resolves once the app that made the call stops or another app takes
    /// the view (at once if it already has). Any executor.
    pub fn closed(&self) -> HostSenderClosed {
        HostSenderClosed {
            caller: self.caller.clone(),
            id: None,
        }
    }
}

/// The future of [`HostSender::closed`].
#[must_use = "futures do nothing unless polled"]
pub struct HostSenderClosed {
    caller: Option<Arc<Caller>>,
    /// Its place among the caller's wakers, once it waited.
    id: Option<u64>,
}

impl std::fmt::Debug for HostSenderClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostSenderClosed").finish_non_exhaustive()
    }
}

impl Future for HostSenderClosed {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        let Some(caller) = &this.caller else {
            return Poll::Ready(());
        };
        if caller.is_closed() {
            return Poll::Ready(());
        }
        {
            let mut waiting = caller.waiting();
            let id = *this.id.get_or_insert_with(|| {
                waiting.0 += 1;
                waiting.0
            });
            waiting.1.insert(id, cx.waker().clone());
        }
        // `close` sets the flag before it takes the wakers: one that ran
        // meanwhile is seen here.
        if caller.is_closed() {
            return Poll::Ready(());
        }
        Poll::Pending
    }
}

impl Drop for HostSenderClosed {
    fn drop(&mut self) {
        if let (Some(caller), Some(id)) = (&self.caller, self.id) {
            caller.waiting().1.remove(&id);
        }
    }
}

/// A URL the app opens (`openUrl` of `nsh/device`), as the embedding app's
/// URL handler gets it ([`HostChannel::handle_open_url`]). Answered once,
/// from any thread: [`OpenUrlRequest::handled`] when the embedding app
/// took it, [`OpenUrlRequest::decline`] for the system to open it (also
/// what dropping it unanswered does).
#[derive(Default)]
#[non_exhaustive]
pub struct OpenUrlRequest {
    url: String,
    reply: Option<UrlReply>,
}

/// Where an [`OpenUrlRequest`]'s answer goes.
struct UrlReply {
    id: u32,
    url: String,
    tx: Sender<Message>,
}

impl std::fmt::Debug for OpenUrlRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenUrlRequest")
            .field("url", &self.url)
            .finish()
    }
}

impl OpenUrlRequest {
    /// The URL: absolute, of a scheme that opens another app
    /// ([`nsh_core::open_url::check_url`]).
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The embedding app took the URL (routed it its own way): the app's
    /// `openUrl` resolves `true` and the system does not open it.
    pub fn handled(self) {
        self.answer(true);
    }

    /// The embedding app leaves the URL to the system, which opens it.
    pub fn decline(self) {
        self.answer(false);
    }

    /// [`OpenUrlRequest::handled`] when `handled`, else
    /// [`OpenUrlRequest::decline`].
    pub fn answer(mut self, handled: bool) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.tx.send(Message::UrlHandled {
                id: reply.id,
                url: reply.url,
                handled,
            });
        }
    }
}

impl Drop for OpenUrlRequest {
    fn drop(&mut self) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.tx.send(Message::UrlHandled {
                id: reply.id,
                url: reply.url,
                handled: false,
            });
        }
    }
}

/// How a call is answered (a [`HostCall`]'s): once, from any thread.
/// Dropped unanswered, the call fails in the app.
#[derive(Default)]
#[non_exhaustive]
pub struct HostReply {
    id: u64,
    name: String,
    /// The queue of the engine that made the call; `None` once answered.
    tx: Option<Sender<Message>>,
    /// Its channel's count of calls, until answered.
    calls: Option<Arc<CallCount>>,
    /// The core made the call (`Message::CoreHostReply`), not JS's channel
    /// (`Message::HostReply`).
    to_core: bool,
}

impl std::fmt::Debug for HostReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostReply")
            .field("name", &self.name)
            .finish()
    }
}

impl HostReply {
    /// The app's promise resolves with `value`.
    pub fn resolve(self, value: JsonValue) {
        self.reply(Ok(value));
    }

    /// The app's promise rejects with an `Error` of `message`.
    pub fn reject(self, message: impl Into<String>) {
        self.reply(Err(message.into()));
    }

    /// Answers with `result`. An app that stopped meanwhile drops it.
    pub fn reply(mut self, result: Result<JsonValue, String>) {
        self.send(result);
        self.answered();
    }

    /// Puts `result` on the queue of the engine that made the call, once.
    fn send(&mut self, result: Result<JsonValue, String>) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(if self.to_core {
                Message::CoreHostReply(self.id, result)
            } else {
                Message::HostReply(self.id, result)
            });
        }
    }

    /// Counts the call answered, once its answer is on the engine's queue.
    fn answered(&mut self) {
        if let Some(calls) = self.calls.take() {
            calls.answered.fetch_add(1, Ordering::SeqCst);
            calls.in_flight.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl Drop for HostReply {
    fn drop(&mut self) {
        if self.tx.is_some() {
            let message = format!(
                "host.call(\"{}\"): the embedding app did not answer",
                self.name
            );
            self.send(Err(message));
        }
        self.answered();
    }
}

#[cfg(all(test, feature = "js-core", not(target_arch = "wasm32")))]
mod tests {
    use std::time::Duration;

    use nsh_core::{ApproxTextEngine, MountBatch};
    use serde_json::json;

    use super::*;
    use crate::{Bundle, Engine, EngineConfig, MountSink};

    struct Sink;

    impl MountSink for Sink {
        fn submit(&self, _: MountBatch) {}
    }

    #[test]
    fn events_sent_while_the_engine_stops_reach_the_next_app() {
        let channel = HostChannel::new();
        let (entered_tx, entered_rx) = crossbeam_channel::bounded(1);
        let (release_tx, release_rx) = crossbeam_channel::bounded(1);
        channel.handle("hold", move |_| {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        let mut config = EngineConfig::new(Bundle::source(
            "import { host } from 'nsh'; host.post('hold');".to_owned(),
        ));
        if let crate::App::Js(bundle) = &mut config.app {
            bundle.policy.declared =
                Some(nsh_core::access::Capabilities::from_json(&json!({ "host": true })).unwrap());
        }
        config.host = channel.clone();
        let engine = Engine::start(config, || ApproxTextEngine, Sink).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // Hold the engine while the platform drops it, as a reload does
        // while the old app is still finishing a callback.
        let stop = engine.stop.clone();
        let dropping = std::thread::spawn(move || drop(engine));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            assert!(
                std::time::Instant::now() < deadline,
                "shutdown did not start"
            );
            std::thread::yield_now();
        }
        for id in 1..=3 {
            channel.send("open", json!(id)).unwrap();
        }
        release_tx.send(()).unwrap();
        dropping.join().unwrap();

        let (seen_tx, seen_rx) = crossbeam_channel::unbounded();
        channel.handle("seen", move |mut call| {
            seen_tx.send(call.take_data()).unwrap();
        });
        let mut config = EngineConfig::new(Bundle::source(
            "import { host } from 'nsh'; host.on('open', data => host.post('seen', data));"
                .to_owned(),
        ));
        if let crate::App::Js(bundle) = &mut config.app {
            bundle.policy.declared =
                Some(nsh_core::access::Capabilities::from_json(&json!({ "host": true })).unwrap());
        }
        config.host = channel;
        let engine = Engine::start(config, || ApproxTextEngine, Sink).unwrap();
        for id in 1..=3 {
            assert_eq!(
                seen_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                json!(id)
            );
        }
        assert!(seen_rx.try_recv().is_err());
        drop(engine);
    }

    fn start(channel: &HostChannel, source: &str) -> Engine {
        let mut config = EngineConfig::new(Bundle::source(source.to_owned()));
        if let crate::App::Js(bundle) = &mut config.app {
            bundle.policy.declared =
                Some(nsh_core::access::Capabilities::from_json(&json!({ "host": true })).unwrap());
        }
        config.host = channel.clone();
        Engine::start(config, || ApproxTextEngine, Sink).unwrap()
    }

    #[test]
    fn a_stand_in_leaves_the_app_without_an_embedding_app() {
        let channel = HostChannel::new();
        let (tx, rx) = crossbeam_channel::unbounded();
        channel.handle_module_fake("probe", move |mut call| {
            tx.send(call.take_data()).unwrap();
            call.resolve(JsonValue::Null);
        });
        channel.fake_module_export("nsh", "Image.prefetch", ModuleFake::Call("probe".into()));
        let engine = start(
            &channel,
            "import { host, Image } from 'nsh'; Image.prefetch(host.available());",
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            json!([false])
        );
        drop(engine);
    }

    #[test]
    fn the_app_s_calls_never_reach_a_stand_in() {
        let channel = HostChannel::new();
        let (faked_tx, faked_rx) = crossbeam_channel::unbounded();
        channel.handle_module_fake("probe", move |call| {
            faked_tx.send(()).unwrap();
            call.resolve(json!("faked"));
        });
        channel.fake_module_export("nsh", "Image.prefetch", ModuleFake::Call("probe".into()));
        let (seen_tx, seen_rx) = crossbeam_channel::unbounded();
        channel.handle("seen", move |mut call| {
            seen_tx.send(call.take_data()).unwrap();
        });
        let engine = start(
            &channel,
            "import { host } from 'nsh'; host.call('probe').then((v) => host.post('seen', v), (e) => host.post('seen', e.message));",
        );
        assert_eq!(
            seen_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            json!("host.call(\"probe\"): the embedding app handles no \"probe\"")
        );
        assert!(faked_rx.try_recv().is_err());
        drop(engine);
    }

    #[test]
    fn recovered_events_keep_the_queue_limit_and_order() {
        let channel = HostChannel::new();
        let (tx, rx) = crossbeam_channel::unbounded();
        let attachment = channel.attach(tx, rx);
        let limit = nsh_core::host_channel::MAX_QUEUED_EVENTS;
        for id in 0..limit + 2 {
            channel.send("open", json!(id)).unwrap();
        }
        drop(attachment);
        let mut inner = channel.lock();
        let kept = inner.pending.take("open");
        assert_eq!(kept.len(), limit);
        assert_eq!(kept[0], json!(2));
        assert_eq!(kept[limit - 1], json!(limit + 1));
    }

    /// A call or post made by the engine whose queue is `tx`.
    fn call_from(channel: &HostChannel, tx: &Sender<Message>) -> HostCall {
        HostCall {
            name: "progress".into(),
            caller: channel.caller(tx),
            ..HostCall::default()
        }
    }

    #[test]
    fn a_caller_s_events_reach_it_alone() {
        let channel = HostChannel::new();
        let (old_tx, old_rx) = crossbeam_channel::unbounded();
        let old = channel.attach(old_tx.clone(), old_rx.clone());
        let sender = call_from(&channel, &old_tx).sender();
        assert!(!sender.is_closed());
        assert_eq!(sender.send("progress", json!(1)), Ok(true));
        assert!(matches!(
            old_rx.try_recv().unwrap(),
            Message::CallerEvent(name, data) if name == "progress" && data == json!(1)
        ));
        assert!(sender.send("", json!(1)).is_err());

        // A reload: another engine takes the view before the old one drops.
        let (tx, rx) = crossbeam_channel::unbounded();
        let current = channel.attach(tx.clone(), rx.clone());
        assert!(sender.is_closed());
        assert_eq!(sender.send("progress", json!(2)), Ok(false));
        assert!(old_rx.try_recv().is_err());
        assert!(rx.try_recv().is_err());
        // The replaced engine's later calls are closed from the start.
        assert!(call_from(&channel, &old_tx).sender().is_closed());
        drop(old);
        assert!(!call_from(&channel, &tx).sender().is_closed());
        drop(current);
    }

    #[test]
    fn a_caller_s_events_are_not_kept_for_the_next_app() {
        let channel = HostChannel::new();
        let (tx, rx) = crossbeam_channel::unbounded();
        let attachment = channel.attach(tx.clone(), rx);
        let sender = call_from(&channel, &tx).sender();
        assert_eq!(sender.send("progress", json!(1)), Ok(true));
        channel.send("open", json!(1)).unwrap();
        // The engine stops before it reads them.
        drop(attachment);
        assert!(sender.is_closed());
        assert_eq!(sender.send("progress", json!(2)), Ok(false));
        let mut inner = channel.lock();
        assert!(inner.pending.take("progress").is_empty());
        assert_eq!(inner.pending.take("open"), vec![json!(1)]);
    }

    #[test]
    fn a_call_made_while_detached_has_a_closed_sender() {
        let channel = HostChannel::new();
        let (tx, _rx) = crossbeam_channel::unbounded();
        let sender = call_from(&channel, &tx).sender();
        assert!(sender.is_closed());
        assert_eq!(sender.send("progress", json!(1)), Ok(false));
        assert!(HostCall::default().sender().is_closed());
        block_on(HostCall::default().sender().closed());
    }

    /// Runs `future` to completion on this thread.
    fn block_on<F: Future>(future: F) -> F::Output {
        struct Unpark(std::thread::Thread);
        impl std::task::Wake for Unpark {
            fn wake(self: Arc<Self>) {
                self.0.unpark();
            }
        }
        let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
        let mut cx = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        loop {
            if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
                return output;
            }
            std::thread::park_timeout(Duration::from_secs(5));
        }
    }

    #[test]
    fn closed_resolves_when_the_caller_detaches() {
        let channel = HostChannel::new();
        let (tx, rx) = crossbeam_channel::unbounded();
        let attachment = channel.attach(tx.clone(), rx);
        let sender = call_from(&channel, &tx).sender();
        // A future dropped while it waits leaves no waker behind.
        {
            let mut closed = std::pin::pin!(sender.closed());
            let waker = Waker::noop();
            assert!(
                closed
                    .as_mut()
                    .poll(&mut Context::from_waker(waker))
                    .is_pending()
            );
        }
        assert!(sender.caller.as_ref().unwrap().waiting().1.is_empty());
        let waiting = std::thread::spawn({
            let sender = sender.clone();
            move || block_on(sender.closed())
        });
        std::thread::sleep(Duration::from_millis(50));
        assert!(!waiting.is_finished());
        drop(attachment);
        waiting.join().unwrap();
        block_on(sender.closed());
    }

    #[test]
    fn a_stopped_app_s_handler_sees_its_sender_closed() {
        let channel = HostChannel::new();
        let (sender_tx, sender_rx) = crossbeam_channel::unbounded();
        channel.handle("progress", move |call| {
            sender_tx.send(call.sender()).unwrap();
            call.resolve(JsonValue::Null);
        });
        let (seen_tx, seen_rx) = crossbeam_channel::unbounded();
        channel.handle("seen", move |mut call| {
            seen_tx.send(call.take_data()).unwrap();
        });
        let engine = start(
            &channel,
            "import { host } from 'nsh'; host.on('progress', data => host.post('seen', data)); host.call('progress');",
        );
        let sender = sender_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(sender.send("progress", json!(1)), Ok(true));
        assert_eq!(
            seen_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            json!(1)
        );
        drop(engine);
        assert!(sender.is_closed());
        assert_eq!(sender.send("progress", json!(2)), Ok(false));

        // The next app gets nothing of the old app's call.
        let engine = start(
            &channel,
            "import { host } from 'nsh'; host.on('progress', data => host.post('seen', data));",
        );
        channel.send("progress", json!("next")).unwrap();
        assert_eq!(
            seen_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            json!("next")
        );
        assert!(seen_rx.try_recv().is_err());
        drop(engine);
    }

    #[test]
    fn an_old_attachment_does_not_detach_its_replacement() {
        let channel = HostChannel::new();
        let (old_tx, old_rx) = crossbeam_channel::unbounded();
        let old = channel.attach(old_tx, old_rx);
        let (tx, rx) = crossbeam_channel::unbounded();
        let current = channel.attach(tx, rx.clone());
        drop(old);
        channel.send("open", json!(1)).unwrap();
        assert!(matches!(
            rx.try_recv().unwrap(),
            Message::HostEvent(name, data) if name == "open" && data == json!(1)
        ));
        drop(current);
    }
}
