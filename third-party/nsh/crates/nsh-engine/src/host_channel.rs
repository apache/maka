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

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use crossbeam_channel::{Receiver, Sender};
#[cfg(feature = "js")]
use nsh_core::host_channel::HostBridge;
use nsh_core::{
    JsonValue,
    host_channel::{HostInbox, check_name},
};

use crate::Message;

/// A handler of the app's calls and posts of one name.
type Handler = Arc<dyn Fn(HostCall) + Send + Sync>;

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
}

#[derive(Default)]
struct Inner {
    params: serde_json::Map<String, JsonValue>,
    configured: bool,
    handlers: HashMap<String, Handler>,
    url_handler: Option<UrlHandler>,
    /// The engine running the view's app: its attachment's id and queue.
    engine: Option<(u64, Sender<Message>)>,
    next_engine: u64,
    /// Events sent while no app ran, for the next one.
    pending: HostInbox,
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

    /// The launch parameters of the apps started from now on
    /// (`host.params`, read synchronously when they start; a running app
    /// keeps the ones it started with). Later requests are events
    /// ([`HostChannel::send`]).
    pub fn set_params(&self, params: serde_json::Map<String, JsonValue>) {
        let mut inner = self.lock();
        inner.params = params;
        inner.configured = true;
    }

    /// The launch parameters ([`HostChannel::set_params`]).
    pub fn params(&self) -> serde_json::Map<String, JsonValue> {
        self.lock().params.clone()
    }

    /// Sends event `name` with `data` to the running app (`host.on(name,
    /// listener)`). The app keeps events of names it does not listen to
    /// yet until it does; while no app runs, events wait for the next one
    /// (up to [`nsh_core::host_channel::MAX_QUEUED_EVENTS`] each, then the
    /// oldest go). Any thread; it never waits for the app. `Err` for a name
    /// that is empty or longer than
    /// [`nsh_core::host_channel::MAX_NAME_LEN`] bytes.
    pub fn send(&self, name: impl Into<String>, data: JsonValue) -> Result<(), String> {
        let name = name.into();
        check_name(&name)?;
        let mut inner = self.lock();
        inner.configured = true;
        if let Some((_, tx)) = &inner.engine
            && tx
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

    #[cfg(feature = "js")]
    fn handler(&self, name: &str) -> Option<Handler> {
        self.lock().handlers.get(name).cloned()
    }

    /// Events sent once JS is interrupted must follow the shutdown
    /// message, so the attachment can recover them for the next app.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn shutdown(&self, tx: &Sender<Message>, stop: &std::sync::atomic::AtomicBool) {
        let _inner = self.lock();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = tx.send(Message::Shutdown);
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
        let mut inner = self.lock();
        inner.next_engine += 1;
        let id = inner.next_engine;
        for (name, data) in inner.pending.take_all() {
            let _ = tx.send(Message::HostEvent(name, data));
        }
        inner.engine = Some((id, tx));
        HostAttachment {
            channel: self.clone(),
            id,
            rx,
        }
    }

    /// The bridge an app's `nsh/host` reaches this channel through, from
    /// the engine whose queue is `tx`: its parameters as they are now.
    #[cfg(feature = "js")]
    pub(crate) fn bridge(&self, tx: Sender<Message>) -> EngineBridge {
        EngineBridge {
            params: JsonValue::Object(self.params()),
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
        let discarded = {
            let mut inner = self.channel.lock();
            if !inner.engine.as_ref().is_some_and(|(id, _)| *id == self.id) {
                return;
            }
            inner.engine = None;
            // Detach and drain under the same lock as `send`: every event
            // either waits here or is kept by `send` for the next app.
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
            messages
        };
        // Other messages can own closures whose destructors reach the
        // channel. Release them without its lock held.
        drop(discarded);
    }
}

/// What an engine's `nsh/host` reaches of the channel
/// ([`nsh_core::host_channel::HostBridge`]).
#[cfg(feature = "js")]
pub(crate) struct EngineBridge {
    params: JsonValue,
    channel: HostChannel,
    tx: Sender<Message>,
}

#[cfg(feature = "js")]
impl EngineBridge {
    /// Runs `handler` with `call`; a handler that panics drops the call,
    /// which fails it in the app.
    fn run(handler: &Handler, call: HostCall) {
        let name = call.name.clone();
        let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(call)));
        if ran.is_err() {
            log::error!("nsh/host: the embedding app's handler of \"{name}\" panicked");
        }
    }
}

#[cfg(feature = "js")]
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
        let call = HostCall {
            name: name.to_owned(),
            data,
            reply: Some(HostReply {
                id,
                name: name.to_owned(),
                tx: Some(self.tx.clone()),
            }),
        };
        Self::run(&handler, call);
        Ok(())
    }

    fn post(&self, name: &str, data: JsonValue) {
        match self.channel.handler(name) {
            Some(handler) => Self::run(
                &handler,
                HostCall {
                    name: name.to_owned(),
                    data,
                    reply: None,
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
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(Message::HostReply(self.id, result));
        }
    }
}

impl Drop for HostReply {
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            let message = format!(
                "host.call(\"{}\"): the embedding app did not answer",
                self.name
            );
            let _ = tx.send(Message::HostReply(self.id, Err(message)));
        }
    }
}

#[cfg(all(test, feature = "js", not(target_arch = "wasm32")))]
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
