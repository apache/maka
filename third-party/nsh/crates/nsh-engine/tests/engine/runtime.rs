//! An embedding application's runtime is selected per engine and stays
//! usable after its engines stop; the shared default remains the fallback.

use std::time::{Duration, Instant};

use nsh_core::{ApproxTextEngine, MountItem, prelude::*};
use nsh_engine::{Engine, EngineConfig, Root};
use tokio::runtime::{Handle, Runtime};

use crate::ChannelSink;

#[component]
fn ShowRuntime() -> impl IntoElement {
    let shown = signal(String::from("waiting"));
    spawn(async move {
        let entered = Handle::current().id();
        let worker = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(1)).await;
            Handle::current().id()
        })
        .await
        .unwrap();
        shown.set(format!("{entered}/{worker}"));
    });
    text(move || shown.get())
}

/// Starts a component task and reads the runtime identities it displays:
/// the entered runtime and a worker the task spawns onto.
fn start(runtime: Option<Handle>) -> (Engine, String) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut config = EngineConfig::new(Root::of::<ShowRuntime>());
    config.runtime = runtime;
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in batch.items {
            if let MountItem::Text { text, .. } = item
                && text.text.contains('/')
            {
                return (engine, text.text.to_string());
            }
        }
    }
    panic!("the runtime task did not complete");
}

fn runtime() -> Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn supplied_runtimes_are_per_engine_and_outlive_their_engines() {
    let first = runtime();
    let second = runtime();
    assert_ne!(first.handle().id(), second.handle().id());

    let active = [&first, &second].map(|runtime| {
        let (engine, shown) = start(Some(runtime.handle().clone()));
        let id = runtime.handle().id();
        assert_eq!(shown, format!("{id}/{id}"));
        engine
    });
    drop(active);

    for runtime in [&first, &second] {
        let (engine, shown) = start(Some(runtime.handle().clone()));
        let id = runtime.handle().id();
        assert_eq!(shown, format!("{id}/{id}"));
        drop(engine);

        let usable = runtime.block_on(async {
            tokio::spawn(async { Handle::current().id() })
                .await
                .unwrap()
        });
        assert_eq!(usable, id);
    }
}

#[test]
fn engines_without_a_supplied_runtime_share_the_default() {
    let (first, shown) = start(None);
    let (entered, worker) = shown.split_once('/').unwrap();
    assert_eq!(entered, worker);
    drop(first);

    let (second, reused) = start(None);
    assert_eq!(reused, shown);
    drop(second);
}
