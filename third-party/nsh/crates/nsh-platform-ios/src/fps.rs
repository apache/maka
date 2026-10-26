//! The performance monitor ([`crate::SurfaceOptions::fps`], the development
//! host's `--fps`): once a second, one `nsh::perf` line of what the
//! surface's frames and commits cost, from its [`PerfMonitor`], in the shape
//! of the desktops' (`examples/gallery/tools/perf.py` reads them all):
//!
//! `fps 120/120 frame 1.21/1.10/2.40/3.90 gap 8.33/8.33/8.40/16.70 over 0%
//! tick 0.40/… drain 0.30/… scroll 0.20/… commits 20 js 0.30/… core 0.50/…
//! items 42 engine 3% cpu 24% mem 92.4 MB`: frames shown in the second over
//! the screen's rate, the main thread's time per shown frame, the gaps
//! between shown frames (one refresh while something moves), the share of
//! frames over one refresh; its phases: `tick` (native animations on the
//! display link), `drain` (applying the engine's batches) and `scroll`
//! (scroll views' offsets: lists, sticky cells, bound values); the engine's
//! commits with their JS and core time, mount items per commit, the engine
//! thread's busy share, the process' CPU (percent of one core) and physical
//! footprint (milliseconds as mean/p50/p95/max).
//!
//! A display link of its own closes the frames, at the screen's full rate,
//! while the monitor runs: a refresh in which the surface's work changed
//! something is a shown frame.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::Arc,
    time::Duration,
};

use nsh_core::time::Instant;
use nsh_engine::perf::{PerfMonitor, PerfSnapshot, ProcessSampler, Stat};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, sel,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSRunLoop, NSRunLoopCommonModes};
use objc2_quartz_core::CADisplayLink;

/// How often a line is logged.
const PERIOD: Duration = Duration::from_secs(1);

define_class!(
    /// The display link's target: closes a frame of its monitor.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = RefCell<Weak<Fps>>]
    #[name = "NshFpsLink"]
    struct LinkTarget;

    unsafe impl NSObjectProtocol for LinkTarget {}

    impl LinkTarget {
        #[unsafe(method(refresh:))]
        fn refresh(&self, link: &CADisplayLink) {
            if let Some(fps) = self.ivars().borrow().upgrade() {
                fps.refresh(link);
            }
        }
    }
);

/// The phases' samples since the last line.
#[derive(Default)]
struct Phases {
    tick: Vec<Duration>,
    drain: Vec<Duration>,
    scroll: Vec<Duration>,
}

/// The monitor of one surface.
pub(crate) struct Fps {
    pub(crate) monitor: Arc<PerfMonitor>,
    sampler: RefCell<ProcessSampler>,
    link: Retained<CADisplayLink>,
    phases: RefCell<Phases>,
    logged: Cell<Instant>,
}

impl Fps {
    /// Starts measuring: its display link runs until it is dropped.
    pub(crate) fn start(mtm: MainThreadMarker) -> Rc<Fps> {
        let target = mtm.alloc::<LinkTarget>().set_ivars(RefCell::default());
        // SAFETY: NSObject's initializer.
        let target: Retained<LinkTarget> = unsafe { msg_send![super(target), init] };
        // SAFETY: `refresh:` is implemented by `LinkTarget`, which the link
        // retains until it is invalidated (`Drop`).
        let link =
            unsafe { CADisplayLink::displayLinkWithTarget_selector(&target, sel!(refresh:)) };
        crate::animation::full_rate(&link);
        // SAFETY: the main run loop and standard modes; common modes keep it
        // running while a scroll view tracks.
        unsafe { link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes) };
        let fps = Rc::new(Fps {
            monitor: Arc::new(PerfMonitor::new()),
            sampler: RefCell::new(ProcessSampler::new()),
            link,
            phases: RefCell::default(),
            logged: Cell::new(Instant::now()),
        });
        *target.ivars().borrow_mut() = Rc::downgrade(&fps);
        fps
    }

    /// The display link's animations ticked in `cost`; `changed`: values
    /// moved.
    pub(crate) fn ticked(&self, cost: Duration, changed: bool) {
        self.monitor.record_work(cost, changed);
        self.phases.borrow_mut().tick.push(cost);
    }

    /// A batch was applied in `cost`.
    pub(crate) fn drained(&self, cost: Duration) {
        self.monitor.record_work(cost, true);
        self.phases.borrow_mut().drain.push(cost);
    }

    /// A scroll view moved; following it took `cost`.
    pub(crate) fn scrolled(&self, cost: Duration) {
        self.monitor.record_work(cost, true);
        self.phases.borrow_mut().scroll.push(cost);
    }

    fn refresh(&self, link: &CADisplayLink) {
        let now = Instant::now();
        let period = (link.targetTimestamp() - link.timestamp()).max(0.0);
        self.monitor.vsync(now, Duration::from_secs_f64(period));
        if now.duration_since(self.logged.get()) < PERIOD {
            return;
        }
        self.logged.set(now);
        self.monitor.set_process(self.sampler.borrow_mut().sample());
        let mut phases = self.phases.borrow_mut();
        let phases = [
            stat(&mut phases.tick),
            stat(&mut phases.drain),
            stat(&mut phases.scroll),
        ];
        log::info!(target: "nsh::perf", "{}", line(&self.monitor.snapshot(), &phases));
    }
}

impl Drop for Fps {
    fn drop(&mut self) {
        self.link.invalidate();
    }
}

/// One second's line (see the module documentation).
fn line(s: &PerfSnapshot, phases: &[Stat; 3]) -> String {
    let process = &s.process;
    format!(
        "fps {:.0}/{:.0} frame {} gap {} over {:.0}% tick {} drain {} scroll {} commits {:.0} js {} core {} \
         items {:.0} engine {:.0}% cpu {} mem {}",
        s.fps,
        s.refresh_rate.unwrap_or(0.0),
        ms(&s.frame),
        ms(&s.frame_interval),
        s.dropped * 100.0,
        ms(&phases[0]),
        ms(&phases[1]),
        ms(&phases[2]),
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
