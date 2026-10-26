//! The performance monitor ([`crate::AppOptions::fps`], `--fps`): once a
//! second, one `nsh::perf` line of what the surface's frames and commits
//! cost, from its [`PerfMonitor`]:
//!
//! `fps 120/120 frame 1.21/1.10/2.40/3.90 gap 8.33/8.33/8.40/16.70 over 0% update 0.10/… layout
//! 0.05/… paint 1.00/… snapshot 0.40/… canvas 0.10/… drain 0.20/0.15/0.60/0.90 commits 20
//! js 0.30/… core 0.50/… items 42 engine 3% cpu 24% rss 92.4 MB`: frames GTK
//! drew in the second over the display's rate, the main thread's time per
//! drawn frame (GTK's frame clock from `before-paint` to `after-paint`), the
//! gaps between drawn frames (one refresh while something moves) and
//! its phases (`update`: tick callbacks, the native animations among them;
//! `layout`: allocation; `paint`: snapshots and GSK's rendering, of which
//! `snapshot` is NSH's views' and `canvas` the canvases' rasterizing in
//! it), the share of frames over one refresh, the
//! time applying the engine's batches per drain, the engine's commits with
//! their JS and core time, mount items per commit, the engine thread's busy
//! share and the process' CPU (percent of one core) and resident memory
//! (milliseconds as mean/p50/p95/max).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::Arc,
    time::Duration,
};

use gtk4::{self as gtk, gdk, prelude::*};
use nsh_core::time::Instant;
use nsh_engine::perf::{PerfMonitor, PerfSnapshot, ProcessSampler, Stat};

/// How often a line is logged.
const PERIOD: Duration = Duration::from_secs(1);

thread_local! {
    /// Some monitor measures on this (main) thread, and the snapshot time
    /// of the frame being painted.
    static MEASURING: Cell<bool> = const { Cell::new(false) };
    static SNAPSHOT: Cell<Duration> = const { Cell::new(Duration::ZERO) };
    static CANVAS: Cell<Duration> = const { Cell::new(Duration::ZERO) };
}

/// Whether a monitor measures (the root view times its snapshots).
pub(crate) fn measuring() -> bool {
    MEASURING.get()
}

/// The root view's snapshot took `cost`.
pub(crate) fn snapshotted(cost: Duration) {
    SNAPSHOT.set(SNAPSHOT.get() + cost);
}

/// Canvases were rasterized in `cost` (part of the snapshot).
pub(crate) fn rasterized(cost: Duration) {
    CANVAS.set(CANVAS.get() + cost);
}

/// The phases of drawn frames since the last line.
#[derive(Default)]
struct Phases {
    update: Vec<Duration>,
    layout: Vec<Duration>,
    paint: Vec<Duration>,
    snapshot: Vec<Duration>,
    canvas: Vec<Duration>,
}

/// The monitor of one surface, and what its frame clock hooks keep.
pub(crate) struct Fps {
    pub(crate) monitor: Arc<PerfMonitor>,
    sampler: RefCell<ProcessSampler>,
    /// When the frame being painted began, when its last phase ended, and
    /// whether GTK painted in it.
    painting: Cell<Option<Instant>>,
    mark: Cell<Option<Instant>>,
    rendered: Cell<bool>,
    /// The phases of the frame being painted.
    update: Cell<Duration>,
    layout: Cell<Duration>,
    phases: RefCell<Phases>,
    /// Batch drains since the last line: their main-thread costs.
    drains: RefCell<Vec<Duration>>,
    logged: Cell<Instant>,
}

impl Fps {
    pub(crate) fn new() -> Fps {
        MEASURING.set(true);
        Fps {
            monitor: Arc::new(PerfMonitor::new()),
            sampler: RefCell::new(ProcessSampler::new()),
            painting: Cell::new(None),
            mark: Cell::new(None),
            rendered: Cell::new(false),
            update: Cell::default(),
            layout: Cell::default(),
            phases: RefCell::default(),
            drains: RefCell::default(),
            logged: Cell::new(Instant::now()),
        }
    }

    /// The engine's batches were applied in `cost`.
    pub(crate) fn drained(&self, cost: Duration) {
        self.monitor.record_work(cost, true);
        self.drains.borrow_mut().push(cost);
    }

    /// A phase ended now: its time since the previous one.
    fn phase(&self) -> Duration {
        let now = Instant::now();
        self.mark
            .replace(Some(now))
            .map_or(Duration::ZERO, |m| now.duration_since(m))
    }
}

/// Measures `widget`'s frames into `fps` once it has a frame clock. Each
/// handler runs after GTK's own of its phase (connected when the window
/// was realized, before the surface's view): it marks the phase's end.
pub(crate) fn install(widget: &gtk::Widget, fps: &Rc<Fps>) {
    let hook = {
        let fps = Rc::downgrade(fps);
        move |widget: &gtk::Widget| {
            if let Some(clock) = widget.frame_clock() {
                connect(&clock, &fps);
            }
        }
    };
    if widget.is_realized() {
        hook(widget);
    }
    widget.connect_realize(hook);
}

fn connect(clock: &gdk::FrameClock, fps: &Weak<Fps>) {
    let weak = fps.clone();
    clock.connect_before_paint(move |_| {
        if let Some(fps) = weak.upgrade() {
            let now = Instant::now();
            fps.painting.set(Some(now));
            fps.mark.set(Some(now));
            fps.rendered.set(false);
            fps.update.set(Duration::ZERO);
            fps.layout.set(Duration::ZERO);
            SNAPSHOT.set(Duration::ZERO);
            CANVAS.set(Duration::ZERO);
        }
    });
    let weak = fps.clone();
    clock.connect_update(move |_| {
        if let Some(fps) = weak.upgrade() {
            fps.update.set(fps.phase());
        }
    });
    let weak = fps.clone();
    clock.connect_layout(move |_| {
        if let Some(fps) = weak.upgrade() {
            fps.layout.set(fps.phase());
        }
    });
    // The paint phase runs only when a surface asked to be drawn (GTK's
    // own `render` handler stops that signal's emission).
    let weak = fps.clone();
    clock.connect_paint(move |_| {
        if let Some(fps) = weak.upgrade() {
            fps.rendered.set(true);
            let paint = fps.phase();
            let mut phases = fps.phases.borrow_mut();
            phases.update.push(fps.update.get());
            phases.layout.push(fps.layout.get());
            phases.paint.push(paint);
            phases.snapshot.push(SNAPSHOT.get());
            phases.canvas.push(CANVAS.get());
        }
    });
    let weak = fps.clone();
    clock.connect_after_paint(move |clock| {
        if let Some(fps) = weak.upgrade() {
            after_paint(&fps, clock);
        }
    });
}

fn after_paint(fps: &Fps, clock: &gdk::FrameClock) {
    let now = Instant::now();
    if let Some(start) = fps.painting.take() {
        fps.monitor
            .record_work(now.duration_since(start), fps.rendered.get());
    }
    let (interval, _) = clock.refresh_info(clock.frame_time());
    let interval = Duration::from_micros(interval.max(0) as u64);
    fps.monitor.vsync(now, interval);
    if now.duration_since(fps.logged.get()) < PERIOD {
        return;
    }
    fps.logged.set(now);
    fps.monitor.set_process(fps.sampler.borrow_mut().sample());
    let drains = stat(&mut fps.drains.borrow_mut());
    let mut phases = fps.phases.borrow_mut();
    let phases = [
        stat(&mut phases.update),
        stat(&mut phases.layout),
        stat(&mut phases.paint),
        stat(&mut phases.snapshot),
        stat(&mut phases.canvas),
    ];
    log::info!(target: "nsh::perf", "{}", line(&fps.monitor.snapshot(), &phases, &drains));
}

/// One second's line (see the module documentation).
fn line(s: &PerfSnapshot, phases: &[Stat; 5], drains: &Stat) -> String {
    let process = &s.process;
    format!(
        "fps {:.0}/{:.0} frame {} gap {} over {:.0}% update {} layout {} paint {} snapshot {} canvas {} drain {} \
         commits {:.0} js {} core {} items {:.0} engine {:.0}% cpu {} rss {}",
        s.fps,
        s.refresh_rate.unwrap_or(0.0),
        ms(&s.frame),
        ms(&s.frame_interval),
        s.dropped * 100.0,
        ms(&phases[0]),
        ms(&phases[1]),
        ms(&phases[2]),
        ms(&phases[3]),
        ms(&phases[4]),
        ms(drains),
        s.commits,
        ms(&s.js),
        ms(&s.layout),
        s.items,
        s.engine_busy,
        process.cpu.map_or("-".into(), |c| format!("{c:.0}%")),
        process
            .memory
            .map_or("-".into(), |m| format!("{:.1} MB", m as f64 / 1e6)),
    )
}

/// The distribution of `samples`, which it empties.
fn stat(samples: &mut Vec<Duration>) -> Stat {
    let mut stat = Stat::default();
    if samples.is_empty() {
        return stat;
    }
    samples.sort_unstable();
    let n = samples.len();
    stat.mean = samples.iter().sum::<Duration>() / n as u32;
    stat.p50 = samples[n / 2];
    stat.p95 = samples[(n * 95 / 100).min(n - 1)];
    stat.max = samples[n - 1];
    samples.clear();
    stat
}

/// `mean/p50/p95/max` in milliseconds.
fn ms(stat: &Stat) -> String {
    let ms = |d: Duration| d.as_secs_f64() * 1e3;
    format!(
        "{:.2}/{:.2}/{:.2}/{:.2}",
        ms(stat.mean),
        ms(stat.p50),
        ms(stat.p95),
        ms(stat.max)
    )
}
