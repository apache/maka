//! Stopping an engine never waits for a long-running script: platforms drop
//! engines on their main thread. The interrupted script is not reported as
//! an error of the app.

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use nsh_core::{ApproxTextEngine, MountBatch, Size, geometry::px};
use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};

/// Records the errors reported.
struct Sink(Arc<Mutex<Vec<String>>>);

impl MountSink for Sink {
    fn submit(&self, _batch: MountBatch) {}

    fn report_error(&self, message: &str) {
        self.0.lock().unwrap().push(message.to_owned());
    }
}

/// Runs `code`, lets it spin, drops the engine: returns how long dropping
/// took and the errors reported.
fn stop_spinning(code: &str) -> (Duration, Vec<String>) {
    let config = EngineConfig {
        app: nsh_engine::App::Js(Bundle::source(code.to_owned())),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Default::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let errors = Arc::new(Mutex::new(Vec::new()));
    let engine = Engine::start(config, || ApproxTextEngine, Sink(errors.clone())).unwrap();
    // Let the script start spinning.
    std::thread::sleep(Duration::from_millis(200));
    let start = Instant::now();
    drop(engine);
    let elapsed = start.elapsed();
    let errors = errors.lock().unwrap().clone();
    (elapsed, errors)
}

#[test]
fn dropping_an_engine_aborts_running_js() {
    let (elapsed, errors) = stop_spinning("let n = 0; while (true) { n++; }");
    assert!(elapsed < Duration::from_millis(500), "{elapsed:?}");
    assert_eq!(errors, Vec::<String>::new());
}

#[test]
fn dropping_an_engine_aborts_a_running_timer_quietly() {
    let (elapsed, errors) =
        stop_spinning("setTimeout(() => { let n = 0; while (true) { n++; } }, 0);");
    assert!(elapsed < Duration::from_millis(500), "{elapsed:?}");
    assert_eq!(errors, Vec::<String>::new());
}
