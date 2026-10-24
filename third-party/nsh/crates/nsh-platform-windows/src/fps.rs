//! The performance monitor ([`crate::AppOptions::fps`], `--fps`): once a
//! second, one `nsh::perf` line of what the surface's frames and commits
//! cost, from its [`PerfMonitor`], in the shape of the other desktop
//! backends' (`examples/gallery/tools/perf.py` reads them all):
//!
//! `fps 120/120 frame 1.21/1.10/2.40/3.90 gap 8.33/8.33/8.40/16.70 over 0%
//! tick 0.10/… drain 0.20/… paint 1.00/… present 6.50/… canvas 0.10/…
//! commits 20 js 0.30/… core 0.50/… items 42 engine 3% cpu 24% mem 92.4 MB`:
//! frames shown in the second over the display's rate, the main thread's
//! time per shown frame (the ticker's work, batches applied and the tree
//! drawn: waiting for the vertical blank in `Present` is not work), the gaps
//! between shown frames (one refresh while something moves) and the share
//! of frames over one refresh; its phases: `tick` (the compositor-paced
//! ticker: animations, frame callbacks), `drain` (batches applied as they
//! arrived), `paint` (Direct2D drawing the tree, canvases included),
//! `present` (the swap chain's `Present`, which waits for the blank) and
//! `canvas` (the canvases' share of `paint`: recording and replaying their
//! drawing, per frame that drew any); the engine's commits with their JS
//! and core time, mount items per commit, the engine thread's busy share,
//! the process' CPU (percent of one core) and working set (milliseconds as
//! mean/p50/p95/max).
//!
//! While it measures the ticker runs on every refresh (it closes the
//! frames), as the macOS display link does.

use std::{
    cell::{Cell, RefCell},
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_engine::perf::{PerfMonitor, PerfSnapshot, ProcessSampler, Stat};
use windows::Win32::Graphics::Dwm::{DWM_TIMING_INFO, DwmGetCompositionTimingInfo};

/// How often a line is logged.
const PERIOD: Duration = Duration::from_secs(1);

thread_local! {
    /// Some monitor measures on this (main) thread, and the canvases'
    /// drawing time of the frame being drawn.
    static MEASURING: Cell<bool> = const { Cell::new(false) };
    static CANVAS: Cell<Duration> = const { Cell::new(Duration::ZERO) };
}

/// Whether a monitor measures (canvases time their drawing).
pub(crate) fn measuring() -> bool {
    MEASURING.get()
}

/// A canvas drew in `cost` (closed into its frame by [`Fps::painted`]).
pub(crate) fn drew_canvas(cost: Duration) {
    CANVAS.set(CANVAS.get() + cost);
}

/// The phases of shown frames since the last line.
#[derive(Default)]
struct Phases {
    tick: Vec<Duration>,
    drain: Vec<Duration>,
    paint: Vec<Duration>,
    present: Vec<Duration>,
    canvas: Vec<Duration>,
}

/// The monitor of one surface.
pub(crate) struct Fps {
    pub(crate) monitor: Arc<PerfMonitor>,
    sampler: RefCell<ProcessSampler>,
    phases: RefCell<Phases>,
    logged: Cell<Instant>,
}

impl Fps {
    pub(crate) fn new() -> Fps {
        MEASURING.set(true);
        Fps {
            monitor: Arc::new(PerfMonitor::new()),
            sampler: RefCell::new(ProcessSampler::new()),
            phases: RefCell::default(),
            logged: Cell::new(Instant::now()),
        }
    }

    /// The engine's batches were applied in `cost`; `applied`: there were
    /// any.
    pub(crate) fn drained(&self, cost: Duration, applied: bool) {
        self.monitor.record_work(cost, applied);
        if applied {
            self.phases.borrow_mut().drain.push(cost);
        }
    }

    /// The window was drawn in `paint` and shown in `present`.
    pub(crate) fn painted(&self, paint: Duration, present: Duration) {
        self.monitor.record_work(paint, true);
        let canvas = CANVAS.take();
        let mut phases = self.phases.borrow_mut();
        phases.paint.push(paint);
        phases.present.push(present);
        if !canvas.is_zero() {
            phases.canvas.push(canvas);
        }
    }

    /// A ticker frame's work took `cost`; `dirty`: it moved something. The
    /// tick closes the frame the work since the previous one belongs to,
    /// and logs a line every second.
    pub(crate) fn ticked(&self, cost: Duration, dirty: bool) {
        self.monitor.record_work(cost, dirty);
        if dirty {
            self.phases.borrow_mut().tick.push(cost);
        }
        let now = Instant::now();
        self.monitor.vsync(now, refresh_period());
        if now.duration_since(self.logged.get()) < PERIOD {
            return;
        }
        self.logged.set(now);
        self.monitor.set_process(self.sampler.borrow_mut().sample());
        let mut phases = self.phases.borrow_mut();
        let stats = [
            stat(&mut phases.tick),
            stat(&mut phases.drain),
            stat(&mut phases.paint),
            stat(&mut phases.present),
            stat(&mut phases.canvas),
        ];
        log::info!(target: "nsh::perf", "{}", line(&self.monitor.snapshot(), &stats));
    }
}

impl Drop for Fps {
    fn drop(&mut self) {
        MEASURING.set(false);
    }
}

/// The compositor's refresh period (zero when it is not known).
fn refresh_period() -> Duration {
    thread_local! {
        static PERIOD: Cell<Option<Duration>> = const { Cell::new(None) };
    }
    if let Some(period) = PERIOD.get() {
        return period;
    }
    let mut info = DWM_TIMING_INFO {
        cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
        ..Default::default()
    };
    // SAFETY: a plain query into a buffer of the size `cbSize` names.
    let period = unsafe { DwmGetCompositionTimingInfo(Default::default(), &mut info) }
        .ok()
        .filter(|_| info.rateRefresh.uiNumerator > 0 && info.rateRefresh.uiDenominator > 0)
        .map_or(Duration::ZERO, |_| {
            Duration::from_secs_f64(
                f64::from(info.rateRefresh.uiDenominator) / f64::from(info.rateRefresh.uiNumerator),
            )
        });
    if !period.is_zero() {
        PERIOD.set(Some(period));
    }
    period
}

/// One second's line (see the module documentation).
fn line(s: &PerfSnapshot, phases: &[Stat; 5]) -> String {
    let process = &s.process;
    format!(
        "fps {:.0}/{:.0} frame {} gap {} over {:.0}% tick {} drain {} paint {} present {} canvas {} \
         commits {:.0} js {} core {} items {:.0} engine {:.0}% cpu {} mem {}",
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
