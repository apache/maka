//! A manual clock (`EngineConfig::clock`): the app's time moves only when
//! the engine is told to move it, and what comes due on the way runs in
//! order, each at its time; `Date` and `performance.now()` follow it.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, MountItem, element::Root, prelude::*, time::Clock};
use nsh_engine::{
    App, Bundle, Engine, EngineConfig, FetchEvent, FetchEvents, FetchTask, HttpHead, HttpRequest,
    Network,
};

/// Sends the batches, and fails on the app's errors.
struct Sink(crossbeam_channel::Sender<MountBatch>);

impl nsh_engine::MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(batch);
    }

    fn report_error(&self, message: &str) {
        panic!("the app failed: {message}");
    }

    fn report(&self, error: &nsh_engine::AppError) {
        panic!("the app failed: {error:?}");
    }
}

/// The time the clock starts at: 2026-01-01T00:00:00Z.
fn start_time() -> std::time::SystemTime {
    std::time::SystemTime::UNIX_EPOCH + Duration::from_millis(1_767_225_600_000)
}

const APP: &str = r#"import { mount, signal, Text } from "nsh";

const log = signal("");
const add = (what) => log.set(`${log()} ${what}@${performance.now()}`);
const started = new Date();
setTimeout(() => add("b"), 300);
setTimeout(() => {
  add("a");
  // What a timer schedules on the way comes due in the same move.
  setTimeout(() => add("c"), 150);
}, 100);
const ticks = signal(0);
const interval = setInterval(() => {
  ticks.set(ticks() + 1);
  if (ticks() === 3) clearInterval(interval);
}, 1000);
mount(() => (
  <Text>{`${started.toISOString()} ${Date.now() - started.getTime()} ${new Date() instanceof Date} ${typeof Date()} ticks ${ticks()}|${log()}`}</Text>
));
"#;

/// A Rust root whose task and interval wait on the clock.
#[component]
fn Waiting() -> impl IntoElement {
    let done = signal("waiting");
    let ticks = signal(0);
    spawn(async move {
        timer(Duration::from_millis(500)).await;
        done.set("done");
    });
    let interval = set_interval(Duration::from_millis(200), move || {
        ticks.update(|t| *t += 1)
    });
    std::mem::forget(interval);
    text(move || format!("{} {}", done.get(), ticks.get()))
}

fn start(clock: Clock) -> (Engine, Receiver<MountBatch>) {
    start_app("nsh-clock", APP, clock, None)
}

/// Starts the app `source` (written to a directory named after `name`) on
/// `clock`, with `network`.
fn start_app(
    name: &str,
    source: &str,
    clock: Clock,
    network: Option<Arc<dyn Network>>,
) -> (Engine, Receiver<MountBatch>) {
    let dir = crate::temporary_root().join(format!("{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, source).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    let config = EngineConfig {
        clock,
        network,
        // SAFETY: compiled just now by this runtime.
        ..EngineConfig::new(nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }))
    };
    let (tx, rx) = crossbeam_channel::unbounded();
    (
        Engine::start(config, || ApproxTextEngine, Sink(tx)).unwrap(),
        rx,
    )
}

/// The last text the batches so far showed.
fn shown(rx: &Receiver<MountBatch>, last: &mut String) -> String {
    while let Ok(batch) = rx.try_recv() {
        for item in &batch.items {
            if let MountItem::Text { text, .. } = item {
                last.clone_from(&text.text);
            }
        }
    }
    last.clone()
}

/// Moves `engine`'s clock by `ms` and waits until it got there.
fn advance(engine: &Engine, ms: u64) {
    let (tx, rx) = crossbeam_channel::bounded(1);
    engine
        .control()
        .advance_clock(Duration::from_millis(ms), move || {
            let _ = tx.send(());
        });
    rx.recv_timeout(Duration::from_secs(10)).unwrap();
}

#[test]
fn a_manual_clock_moves_only_when_told_and_runs_what_comes_due_in_order() {
    let (engine, rx) = start(Clock::manual(start_time()));
    let mut last = String::new();
    advance(&engine, 0);
    assert_eq!(
        shown(&rx, &mut last),
        "2026-01-01T00:00:00.000Z 0 true string ticks 0|"
    );
    // Time stands still on its own.
    std::thread::sleep(Duration::from_millis(400));
    advance(&engine, 0);
    assert_eq!(
        shown(&rx, &mut last),
        "2026-01-01T00:00:00.000Z 0 true string ticks 0|"
    );
    // Each timer runs at its time, the one `a` scheduled included (the
    // text renders as `c` runs, at 250 ms).
    advance(&engine, 260);
    assert_eq!(
        shown(&rx, &mut last),
        "2026-01-01T00:00:00.000Z 250 true string ticks 0| a@100 c@250"
    );
    // The interval ticks at 1, 2 and 3 s, then stops.
    advance(&engine, 5000);
    assert_eq!(
        shown(&rx, &mut last),
        "2026-01-01T00:00:00.000Z 3000 true string ticks 3| a@100 c@250 b@300"
    );
}

/// Runs what was sent to `engine` and is due now: whether it is idle.
fn flush(engine: &Engine) -> bool {
    let (tx, rx) = crossbeam_channel::bounded(1);
    engine.control().flush(move |idle| {
        let _ = tx.send(idle);
    });
    rx.recv_timeout(Duration::from_secs(10)).unwrap()
}

/// Answers `/now` as it is asked, and holds the other requests until the
/// test answers them.
#[derive(Default)]
struct HeldNetwork(Mutex<Vec<FetchEvents>>);

struct Held;

impl FetchTask for Held {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {}
}

impl Network for HeldNetwork {
    fn fetch(&self, request: HttpRequest, mut events: FetchEvents) -> Box<dyn FetchTask> {
        if request.url.ends_with("/now") {
            events(FetchEvent::Head(HttpHead {
                status: 200,
                ..HttpHead::default()
            }));
            events(FetchEvent::Data(b"here".to_vec()));
            events(FetchEvent::End);
        } else {
            self.0.lock().unwrap().push(events);
        }
        Box::new(Held)
    }
}

const FLUSHED: &str = r#"import { mount, signal, Text } from "nsh";

const log = signal("");
const add = (what) => log.set(`${log()} ${what}@${performance.now()}`);
// Due now, a turn after another: a microtask, then a timer that sets one.
Promise.resolve().then(() => setTimeout(() => setTimeout(() => add("now"), 0), 0));
setTimeout(() => {
  add("later");
  fetch("https://example.com/held").then(() => {
    add("answered");
    // Answered as it is asked, at the end of the turn that asked.
    return fetch("https://example.com/now")
      .then((r) => r.text())
      .then(add);
  });
}, 100);
mount(() => <Text>{`log:${log()}`}</Text>);
"#;

#[test]
fn a_flush_runs_what_is_due_now_and_says_whether_the_engine_is_idle() {
    let network = Arc::new(HeldNetwork::default());
    let (engine, rx) = start_app(
        "nsh-clock-flush",
        FLUSHED,
        Clock::manual(start_time()),
        Some(network.clone()),
    );
    let mut last = String::new();
    // The first render, and the work due at its time, with the clock
    // where it was.
    assert!(flush(&engine));
    assert_eq!(shown(&rx, &mut last), "log: now@0");
    // A request in flight: its answer comes from elsewhere.
    advance(&engine, 100);
    assert!(!flush(&engine));
    assert_eq!(shown(&rx, &mut last), "log: now@0 later@100");
    let mut events = network.0.lock().unwrap().pop().unwrap();
    events(FetchEvent::Head(HttpHead {
        status: 200,
        ..HttpHead::default()
    }));
    events(FetchEvent::End);
    assert!(flush(&engine));
    assert_eq!(
        shown(&rx, &mut last),
        "log: now@0 later@100 answered@100 here@100"
    );
}

#[test]
fn the_system_clock_ignores_moves() {
    let (engine, rx) = start(Clock::system());
    let mut last = String::new();
    advance(&engine, 10_000);
    let text = shown(&rx, &mut last);
    assert!(text.ends_with("ticks 0|"), "{text}");
}

#[test]
fn rust_tasks_wait_on_the_manual_clock_too() {
    let config = EngineConfig {
        clock: Clock::manual(start_time()),
        ..EngineConfig::new(App::Rust(Root::new::<Waiting>(|| ())))
    };
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(config, || ApproxTextEngine, Sink(tx)).unwrap();
    let mut last = String::new();
    advance(&engine, 0);
    std::thread::sleep(Duration::from_millis(300));
    advance(&engine, 0);
    assert_eq!(shown(&rx, &mut last), "waiting 0");
    advance(&engine, 450);
    assert_eq!(shown(&rx, &mut last), "waiting 2");
    advance(&engine, 50);
    assert_eq!(shown(&rx, &mut last), "done 2");
}

const FRAMES: &str = r#"import { mount, signal, Text } from "nsh";

const frames = signal(0);
const at = signal(0);
const loop = (time) => {
  frames.set(frames() + 1);
  at.set(Math.round(time));
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
mount(() => <Text>{`${frames()} frames, the last at ${at()}`}</Text>);
"#;

#[test]
fn a_clock_that_moves_with_frames_runs_them_at_the_display_pace() {
    let dir = crate::temporary_root().join(format!("nsh-clock-frames-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, FRAMES).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    let config = EngineConfig {
        clock: Clock::manual(start_time()).with_frames(),
        // SAFETY: compiled just now by this runtime.
        ..EngineConfig::new(nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }))
    };
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(config, || ApproxTextEngine, Sink(tx)).unwrap();
    let mut last = String::new();
    // A second of the app's time: a frame every 1/60 s on the way, as
    // a headless run's display gives them.
    advance(&engine, 1000);
    assert_eq!(shown(&rx, &mut last), "59 frames, the last at 983");
    // The platform's display frame comes a frame after the last: the
    // clock moves to its time first.
    engine.control().frame();
    advance(&engine, 0);
    assert_eq!(shown(&rx, &mut last), "60 frames, the last at 1000");
}
