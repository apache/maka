//! Idle collections during an animation: an app holding a few hundred
//! thousand JS objects runs a frame callback every frame while the test
//! plays the display at 60 Hz. A frame the engine has not answered by the
//! next refresh is a missed one.
//!
//! Run with `cargo test --release -p nsh-engine --test engine bench_gc_animation -- --ignored --nocapture`
//! (`NSH_GC_BENCH_ROWS` rows of two objects each, 150000 by default;
//! `NSH_GC_BENCH_SECS` seconds, 20 by default).

use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{ApproxTextEngine, MountBatch};
use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};

/// Batches as they arrive, and the engine's requests for a frame.
struct DisplaySink {
    batches: Sender<Instant>,
    frames: Sender<()>,
}

impl MountSink for DisplaySink {
    fn submit(&self, _batch: MountBatch) {
        let _ = self.batches.send(Instant::now());
    }

    fn request_frame(&self) {
        let _ = self.frames.send(());
    }
}

fn app(rows: usize) -> String {
    format!(
        r#"import {{ mount, signal, Text }} from "nsh";

// What the app holds: {rows} rows of two GC objects each.
const rows = [];
for (let i = 0; i < {rows}; i++) {{
  rows.push({{ id: i, name: "row " + i, price: i * 0.5, tags: [i % 7] }});
}}
globalThis.rows = rows;

const frames = signal(0);
const loop = () => {{
  frames.set(frames() + 1);
  requestAnimationFrame(loop);
}};
requestAnimationFrame(loop);
mount(() => <Text>{{`${{frames()}} frames`}}</Text>);
"#
    )
}

fn env(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[test]
#[ignore]
fn bench_gc_animation() {
    let rows = env("NSH_GC_BENCH_ROWS", 150_000) as usize;
    let secs = env("NSH_GC_BENCH_SECS", 20);
    let dir = crate::temporary_root().join(format!("nsh-gc-bench-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app(rows)).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
        ..Default::default()
    })
    .unwrap();
    let (batches_tx, batches) = crossbeam_channel::unbounded();
    let (frames_tx, frames) = crossbeam_channel::unbounded();
    let config = EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)));
    let engine = Engine::start(
        config,
        || ApproxTextEngine,
        DisplaySink {
            batches: batches_tx,
            frames: frames_tx,
        },
    )
    .unwrap();
    let monitor = std::sync::Arc::new(nsh_engine::perf::PerfMonitor::new());
    engine.control().set_perf_monitor(Some(monitor.clone()));

    // Wait for the app to build its rows and ask for its first frame.
    frames
        .recv_timeout(Duration::from_secs(60))
        .expect("the app never asked for a frame");
    let period = Duration::from_secs_f64(1.0 / 60.0);
    let start = Instant::now();
    let end = start + Duration::from_secs(secs);
    let (mut refreshes, mut answered, mut missed) = (0u32, 0u32, 0u32);
    let mut longest = Duration::ZERO;
    let mut gcs = 0u32;
    let mut gc_longest = Duration::ZERO;
    // The frame sent and not answered yet.
    let mut pending: Option<Instant> = None;
    let mut requested = true;
    let mut next = start;
    while next < end {
        // The refresh: a frame answered by now made it, one still pending
        // missed this refresh.
        wait_until(
            next,
            &batches,
            &frames,
            &mut pending,
            &mut requested,
            &mut answered,
            &mut longest,
        );
        refreshes += 1;
        if pending.is_some() {
            missed += 1;
        } else if requested {
            requested = false;
            pending = Some(Instant::now());
            engine.control().frame();
        }
        next += period;
        let gc = monitor.snapshot().gc;
        if gc.count > 0 {
            gc_longest = gc_longest.max(gc.longest);
        }
        gcs = gcs.max(gc.count);
    }
    let elapsed = start.elapsed();
    // Then stop the frames: the collection that waited runs.
    std::thread::sleep(Duration::from_millis(1500));
    let after = monitor.snapshot().gc;
    eprintln!(
        "rows {rows} ({} objects) over {:.1} s: {refreshes} refreshes, {answered} frames, \
         {missed} missed ({:.1}%), longest frame {:.1} ms; idle collections during the \
         animation (most in 10 s) {gcs}, longest {:.1} ms; 1.5 s after it stopped {} (longest {:.1} ms)",
        rows * 2,
        elapsed.as_secs_f32(),
        missed as f32 / refreshes as f32 * 100.0,
        longest.as_secs_f64() * 1e3,
        gc_longest.as_secs_f64() * 1e3,
        after.count,
        after.longest.as_secs_f64() * 1e3,
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Takes the batches and frame requests that come until `at`.
fn wait_until(
    at: Instant,
    batches: &Receiver<Instant>,
    frames: &Receiver<()>,
    pending: &mut Option<Instant>,
    requested: &mut bool,
    answered: &mut u32,
    longest: &mut Duration,
) {
    loop {
        let now = Instant::now();
        if now >= at {
            return;
        }
        crossbeam_channel::select! {
            recv(batches) -> batch => {
                if let (Ok(done), Some(sent)) = (batch, pending.take()) {
                    *answered += 1;
                    *longest = (*longest).max(done.duration_since(sent));
                }
            }
            recv(frames) -> _ => *requested = true,
            default(at - now) => return,
        }
    }
}
