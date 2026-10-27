//! A host whose engine runs on its own event loop (`LocalEngine`, the web's
//! main thread) learns when there is work outside a pump: a task woken by
//! one of the host's callbacks (a WebSocket message through wasm-bindgen)
//! calls the wake set with `LocalEngine::set_wake` exactly once, and the
//! next pump runs it. What a pump wakes itself it runs, without a wake.

use std::{
    cell::RefCell,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, MountItem, element::Root, prelude::*};
use nsh_engine::{App, EngineConfig, EngineContext, LocalEngine};
use tokio::sync::oneshot;

use crate::ChannelSink;

thread_local! {
    /// What the app's task waits for: sent by the test, as a host's
    /// callback would deliver it.
    static MESSAGE: RefCell<Option<oneshot::Receiver<String>>> = const { RefCell::new(None) };
    /// What a task's destructor read from this engine's context.
    static RELEASED: RefCell<Option<Arc<Mutex<Option<&'static str>>>>> = const { RefCell::new(None) };
}

/// The host value one engine was given, read again when a task drops.
struct EngineId(&'static str);

/// Records the context a task's destructor sees.
struct Probe {
    seen: Arc<Mutex<Option<&'static str>>>,
}

impl Drop for Probe {
    fn drop(&mut self) {
        let found = engine_context::<EngineId>().map(|id| id.0);
        *self.seen.lock().expect("probe") = Some(found.unwrap_or("none"));
    }
}

/// A task that is still running when the engine drops.
#[component]
fn Holding() -> impl IntoElement {
    let seen = RELEASED.with(|slot| slot.borrow().clone().expect("probe slot"));
    spawn(async move {
        let _probe = Probe { seen };
        std::future::pending::<()>().await;
    });
    text("held")
}

#[component]
fn Echo() -> impl IntoElement {
    let shown = signal(String::from("waiting"));
    let message = MESSAGE.with(|m| m.borrow_mut().take());
    spawn(async move {
        if let Some(message) = message
            && let Ok(text) = message.await
        {
            shown.set(text);
        }
    });
    text(move || shown.get())
}

#[component]
fn Relay() -> impl IntoElement {
    let shown = signal(String::from("waiting"));
    let (tx, rx) = oneshot::channel::<String>();
    // Polled first, so it waits: the next task wakes it, inside the pump.
    spawn(async move {
        if let Ok(text) = rx.await {
            shown.set(text);
        }
    });
    spawn(async move {
        let _ = tx.send("relayed".into());
        // So is a task spawned there.
        spawn(async move {
            shown.update(|text| text.push('!'));
        });
    });
    text(move || shown.get())
}

/// The texts in the batches received so far.
fn texts(rx: &Receiver<MountBatch>) -> Vec<String> {
    let mut texts = Vec::new();
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(10)) {
        for item in &batch.items {
            if let MountItem::Text { text, .. } = item {
                texts.push(text.text.clone());
            }
        }
    }
    texts
}

#[test]
fn dropping_a_local_engine_drops_a_task_in_that_engines_context() {
    let seen = Arc::new(Mutex::new(None));
    RELEASED.with(|slot| *slot.borrow_mut() = Some(seen.clone()));
    let (tx, _rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        context: EngineContext::default().with(EngineId("own")),
        ..EngineConfig::new(App::Rust(Root::of::<Holding>()))
    };
    let mut engine = LocalEngine::start(config, ApproxTextEngine, ChannelSink(tx)).unwrap();
    // The first pump polls the task, so the probe is alive inside it.
    engine.pump();
    assert_eq!(
        *seen.lock().expect("probe"),
        None,
        "the task is still running"
    );
    // Another engine's context is current. The drop must read its own.
    let _outer = EngineContext::default().with(EngineId("outer")).enter();
    drop(engine);
    assert_eq!(*seen.lock().expect("probe"), Some("own"));
    assert_eq!(
        engine_context::<EngineId>().as_deref().map(|id| id.0),
        Some("outer"),
        "the outer engine's context is restored"
    );
    RELEASED.with(|slot| *slot.borrow_mut() = None);
}

#[test]
fn external_wake_asks_for_one_pump_and_the_pump_runs_the_task() {
    let (send, message) = oneshot::channel();
    MESSAGE.with(|m| *m.borrow_mut() = Some(message));
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig::new(App::Rust(Root::of::<Echo>()));
    let mut engine = LocalEngine::start(config, ApproxTextEngine, ChannelSink(tx)).unwrap();
    let wakes = Arc::new(AtomicUsize::new(0));
    let counted = wakes.clone();
    engine.set_wake(Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    engine.pump();
    assert_eq!(texts(&rx).last().map(String::as_str), Some("waiting"));
    // Nothing is due: no timer, no input; the task waits for the host.
    let before = wakes.load(Ordering::SeqCst);
    // The host's callback, outside any pump.
    send.send("hello".into()).unwrap();
    assert_eq!(
        wakes.load(Ordering::SeqCst) - before,
        1,
        "one wake for one woken task"
    );
    assert!(texts(&rx).is_empty(), "nothing runs before the host pumps");
    engine.pump();
    assert_eq!(texts(&rx).last().map(String::as_str), Some("hello"));
    assert_eq!(
        wakes.load(Ordering::SeqCst) - before,
        1,
        "running the task asks for no further pump"
    );
}

#[test]
fn external_wake_is_optional() {
    // Without a wake the engine behaves as before: the host pumps at the
    // deadline or on input, and the woken task runs then.
    let (send, message) = oneshot::channel();
    MESSAGE.with(|m| *m.borrow_mut() = Some(message));
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig::new(App::Rust(Root::of::<Echo>()));
    let mut engine = LocalEngine::start(config, ApproxTextEngine, ChannelSink(tx)).unwrap();
    engine.pump();
    assert_eq!(texts(&rx).last().map(String::as_str), Some("waiting"));
    send.send("later".into()).unwrap();
    engine.pump();
    assert_eq!(texts(&rx).last().map(String::as_str), Some("later"));
}

#[test]
fn external_wake_is_not_called_for_what_a_pump_wakes() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig::new(App::Rust(Root::of::<Relay>()));
    let mut engine = LocalEngine::start(config, ApproxTextEngine, ChannelSink(tx)).unwrap();
    let wakes = Arc::new(AtomicUsize::new(0));
    let counted = wakes.clone();
    engine.set_wake(Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    // The first pump polls the tasks: one wakes the other and spawns a
    // third, and the same pump runs both.
    engine.pump();
    assert_eq!(texts(&rx).last().map(String::as_str), Some("relayed!"));
    assert_eq!(
        wakes.load(Ordering::SeqCst),
        0,
        "a pump asks for no pump for what it runs itself"
    );
}
