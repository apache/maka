//! Performance monitoring: what a surface's frames and commits cost while it
//! runs, for an on-screen monitor (`--fps`) or the app's own tooling.
//!
//! A [`PerfMonitor`] is shared by the two threads of a surface:
//!
//! - the **engine thread** records every wake-up that produced a commit
//!   (the JS it ran and the core's apply, render and layout,
//!   [`CommitTiming`]) and how long it was busy at all;
//! - the **main thread** records the time it spends on the surface
//!   ([`PerfMonitor::record_work`]: applying batches, ticking animations and
//!   frame callbacks, handling input) and closes a frame at every display
//!   refresh ([`PerfMonitor::vsync`]): a refresh in which something changed is
//!   a frame the screen showed, and its cost is the main-thread work since
//!   the previous refresh. It also reports how long a batch waited between
//!   the engine handing it over and the main thread applying it
//!   ([`PerfMonitor::record_latency`]).
//!
//! [`PerfMonitor::snapshot`] turns what was recorded into readings
//! ([`PerfSnapshot`]); [`ProcessSampler`] reads the process' CPU and memory.
//!
//! Nothing is measured while no monitor is installed
//! ([`crate::EngineControl::set_perf_monitor`]): the engine checks one
//! `Option` per wake-up, the platforms one per frame.
//!
//! The readings follow gpui-kit's `gpui-fps` (the same idea, the same rows):
//! the headline rate counts frames that reached the screen, `MAX` is derived
//! from what a frame cost rather than counted (so the monitor never drives
//! frames to find it), and the first frames, the cold ones, are not counted.

use std::{collections::VecDeque, sync::Mutex, time::Duration};

use nsh_core::time::Instant;

/// Samples kept for the distributions (frames, commits).
const CAPACITY: usize = 120;

/// The window over which rates (frames, commits per second) are counted.
const RATE_WINDOW: Duration = Duration::from_secs(1);

/// Frames and commits not counted after the monitor is installed: the
/// first ones after a start are cold (caches, fonts, the first layout) and
/// are not what the app costs to run.
const WARMUP: u32 = 4;

/// What one engine wake-up that committed cost.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CommitTiming {
    /// The app's code: JS event handlers, timers, microtasks, list binds
    /// and the decoding of what they rendered (or a Rust app's tasks): the
    /// wake-up's time less [`CommitTiming::layout`].
    pub js: Duration,
    /// The core: applying the ops, rendering components, typesetting text,
    /// layout and diffing into mount items.
    pub layout: Duration,
    /// Ops applied.
    pub ops: u32,
    /// Mount items produced.
    pub items: u32,
}

/// Mean, 95th percentile and maximum of a set of durations.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Stat {
    /// The mean.
    pub mean: Duration,
    /// The median.
    pub p50: Duration,
    /// The nearest sample at the 95th percentile.
    pub p95: Duration,
    /// The longest.
    pub max: Duration,
}

impl Stat {
    fn of(samples: impl Iterator<Item = Duration>) -> Stat {
        let mut sorted: Vec<Duration> = samples.collect();
        if sorted.is_empty() {
            return Stat::default();
        }
        sorted.sort_unstable();
        let sum: Duration = sorted.iter().sum();
        let at = |q: f32| ((sorted.len() as f32 * q).ceil() as usize).clamp(1, sorted.len()) - 1;
        let p95 = at(0.95);
        Stat {
            mean: sum / sorted.len() as u32,
            p50: sorted[at(0.5)],
            p95: sorted[p95],
            max: sorted[sorted.len() - 1],
        }
    }
}

/// The process' resource use ([`ProcessSampler`]).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ProcessSample {
    /// CPU time over wall time since the previous sample, in percent of one
    /// core (as `top` and Activity Monitor show it: 150 is one and a half
    /// cores busy).
    pub cpu: Option<f32>,
    /// Memory the process owns, in bytes: the physical footprint on Apple
    /// platforms (Activity Monitor's Memory column), the resident set
    /// elsewhere.
    pub memory: Option<u64>,
    /// GPU time over wall time, in percent, where the platform tells it
    /// per process (macOS).
    pub gpu: Option<f32>,
}

/// What a [`PerfMonitor`] read, as of one moment.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PerfSnapshot {
    /// Frames shown per second over the last second: display refreshes in
    /// which the surface changed. Low while the app is idle, which is not
    /// slowness.
    pub fps: f32,
    /// What the main thread could keep up with: one over the mean frame
    /// cost, capped at the display's rate when it is known.
    pub max_fps: f32,
    /// The rate the display link asks for (Hz: its period), once it ran.
    pub refresh_rate: Option<f32>,
    /// The gaps between refreshes as they were delivered, over the last
    /// [`CAPACITY`]: a mean above one period means refreshes came late or
    /// were skipped (a main thread busy when they were due).
    pub tick_interval: Stat,
    /// The gaps between shown frames over the last [`CAPACITY`] (long while
    /// the app is idle, one period while it animates smoothly).
    pub frame_interval: Stat,
    /// Main-thread time per shown frame (applying batches, animations,
    /// input), over the last [`CAPACITY`] frames.
    pub frame: Stat,
    /// Share of those frames that took longer than one refresh, in `0..=1`.
    pub dropped: f32,
    /// Commits per second over the last second.
    pub commits: f32,
    /// The app's code per commit.
    pub js: Stat,
    /// The core's work per commit.
    pub layout: Stat,
    /// Mean mount items per commit.
    pub items: f32,
    /// How long batches waited between the engine thread handing them over
    /// and the main thread applying them.
    pub latency: Stat,
    /// The engine thread's busy time over the last second, in percent.
    pub engine_busy: f32,
    /// Main-thread cost of the retained frames, oldest first (for a trace).
    pub frames: Vec<Duration>,
    /// The process' resource use, as last given to [`PerfMonitor::set_process`].
    pub process: ProcessSample,
}

/// Collects a surface's frame and commit timings. Shared by its engine
/// thread and its main thread (`Arc`); see the module documentation.
#[derive(Debug)]
pub struct PerfMonitor {
    inner: Mutex<Inner>,
}

#[derive(Debug)]
struct Inner {
    /// Main-thread work since the last refresh, and whether it changed
    /// anything.
    pending: Duration,
    dirty: bool,
    /// Shown frames: when, and their main-thread cost.
    frames: VecDeque<(Instant, Duration)>,
    frame_warmup: u32,
    refresh: Option<f32>,
    /// The previous refresh, and the gaps between refreshes as they were
    /// delivered (a late or skipped one shows as a long gap).
    last_vsync: Option<Instant>,
    ticks: VecDeque<Duration>,
    commits: VecDeque<(Instant, CommitTiming)>,
    commit_warmup: u32,
    latencies: VecDeque<Duration>,
    /// Engine wake-ups: when they ended, and how long they were busy.
    busy: VecDeque<(Instant, Duration)>,
    process: ProcessSample,
}

impl Default for PerfMonitor {
    fn default() -> Self {
        PerfMonitor {
            inner: Mutex::new(Inner {
                pending: Duration::ZERO,
                dirty: false,
                frames: VecDeque::with_capacity(CAPACITY),
                frame_warmup: WARMUP,
                refresh: None,
                last_vsync: None,
                ticks: VecDeque::with_capacity(CAPACITY),
                commits: VecDeque::with_capacity(CAPACITY),
                commit_warmup: WARMUP,
                latencies: VecDeque::with_capacity(CAPACITY),
                busy: VecDeque::new(),
                process: ProcessSample::default(),
            }),
        }
    }
}

fn push<T>(queue: &mut VecDeque<T>, value: T) {
    if queue.len() == CAPACITY {
        queue.pop_front();
    }
    queue.push_back(value);
}

impl PerfMonitor {
    /// An empty monitor.
    pub fn new() -> PerfMonitor {
        PerfMonitor::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Main thread: `cost` was spent on the surface; `dirty` if it changed
    /// what the screen shows (a batch was applied, an animation stepped, a
    /// scroll view moved).
    pub fn record_work(&self, cost: Duration, dirty: bool) {
        let mut inner = self.lock();
        inner.pending += cost;
        inner.dirty |= dirty;
    }

    /// Main thread: the display refreshed at `at`, `interval` after the
    /// previous refresh (the display link's period). Closes the frame the
    /// work since the previous refresh belongs to.
    pub fn vsync(&self, at: Instant, interval: Duration) {
        let mut inner = self.lock();
        if interval > Duration::ZERO {
            let rate = 1.0 / interval.as_secs_f32();
            // Smoothed: a link's period is exact, a measured one jitters.
            inner.refresh = Some(match inner.refresh {
                Some(r) if (r - rate).abs() < r * 0.1 => r + (rate - r) * 0.1,
                _ => rate,
            });
        }
        if let Some(last) = inner.last_vsync.replace(at) {
            let gap = at.duration_since(last);
            // A pause (nothing wanted frames, the link stopped) is not a
            // late refresh.
            if gap < Duration::from_millis(100) {
                push(&mut inner.ticks, gap);
            }
        }
        let cost = std::mem::take(&mut inner.pending);
        if !std::mem::take(&mut inner.dirty) {
            return;
        }
        if inner.frame_warmup > 0 {
            inner.frame_warmup -= 1;
            return;
        }
        push(&mut inner.frames, (at, cost));
    }

    /// Main thread: a batch was applied `latency` after the engine handed
    /// it over.
    pub fn record_latency(&self, latency: Duration) {
        let mut inner = self.lock();
        // The first batches wait for the cold first frames.
        if inner.frame_warmup == 0 {
            push(&mut inner.latencies, latency);
        }
    }

    /// Engine thread: a wake-up that committed.
    pub fn record_commit(&self, timing: CommitTiming) {
        let mut inner = self.lock();
        if inner.commit_warmup > 0 {
            inner.commit_warmup -= 1;
            return;
        }
        push(&mut inner.commits, (Instant::now(), timing));
    }

    /// Engine thread: a wake-up was busy for `busy`.
    pub fn record_busy(&self, busy: Duration) {
        let now = Instant::now();
        let mut inner = self.lock();
        inner.busy.push_back((now, busy));
        while inner
            .busy
            .front()
            .is_some_and(|&(at, _)| now.duration_since(at) > RATE_WINDOW)
        {
            inner.busy.pop_front();
        }
    }

    /// Stores the process' latest resource use ([`ProcessSampler`]), shown
    /// with the next snapshots.
    pub fn set_process(&self, sample: ProcessSample) {
        self.lock().process = sample;
    }

    /// The readings as of now.
    pub fn snapshot(&self) -> PerfSnapshot {
        let now = Instant::now();
        let inner = self.lock();
        let recent = |at: Instant| now.duration_since(at) <= RATE_WINDOW;
        // `n` frames span `n - 1` intervals: the rate is measured over the
        // span they cover, which keeps it right before the window fills.
        let shown: Vec<Instant> = inner
            .frames
            .iter()
            .map(|&(at, _)| at)
            .filter(|&at| recent(at))
            .collect();
        let fps = match (shown.first(), shown.last()) {
            (Some(&first), Some(&last)) if shown.len() >= 2 && last > first => {
                // The span to now when the frames stopped: an app that went
                // idle reads as fewer frames, not as its last burst.
                let span = now.duration_since(first).max(last.duration_since(first));
                (shown.len() - 1) as f32 / span.as_secs_f32()
            }
            _ => 0.0,
        };
        let frame = Stat::of(inner.frames.iter().map(|&(_, cost)| cost));
        let budget = Duration::from_secs_f32(1.0 / inner.refresh.unwrap_or(60.0));
        let dropped = match inner.frames.len() {
            0 => 0.0,
            n => {
                inner
                    .frames
                    .iter()
                    .filter(|&&(_, cost)| cost > budget)
                    .count() as f32
                    / n as f32
            }
        };
        let max_fps = if frame.mean > Duration::ZERO {
            let max = 1.0 / frame.mean.as_secs_f32();
            inner.refresh.map_or(max, |r| max.min(r))
        } else {
            0.0
        };
        let commits = inner.commits.iter().filter(|&&(at, _)| recent(at)).count() as f32;
        let items = match inner.commits.len() {
            0 => 0.0,
            n => {
                inner
                    .commits
                    .iter()
                    .map(|(_, c)| c.items as f32)
                    .sum::<f32>()
                    / n as f32
            }
        };
        let busy: Duration = inner
            .busy
            .iter()
            .filter(|&&(at, _)| recent(at))
            .map(|&(_, d)| d)
            .sum();
        PerfSnapshot {
            fps,
            max_fps,
            refresh_rate: inner.refresh,
            tick_interval: Stat::of(inner.ticks.iter().copied()),
            frame_interval: Stat::of(
                inner
                    .frames
                    .iter()
                    .zip(inner.frames.iter().skip(1))
                    .map(|(&(a, _), &(b, _))| b.duration_since(a)),
            ),
            frame,
            dropped,
            commits,
            js: Stat::of(inner.commits.iter().map(|(_, c)| c.js)),
            layout: Stat::of(inner.commits.iter().map(|(_, c)| c.layout)),
            items,
            latency: Stat::of(inner.latencies.iter().copied()),
            engine_busy: busy.as_secs_f32() / RATE_WINDOW.as_secs_f32() * 100.0,
            frames: inner.frames.iter().map(|&(_, cost)| cost).collect(),
            process: inner.process,
        }
    }
}

/// Reads the process' CPU and memory use. CPU use is a rate: each
/// [`ProcessSampler::sample`] reports the CPU time since the previous one
/// over the wall time between them (the first reports none).
#[derive(Debug)]
pub struct ProcessSampler {
    last: Option<(Duration, Instant)>,
}

impl Default for ProcessSampler {
    fn default() -> Self {
        ProcessSampler::new()
    }
}

impl ProcessSampler {
    /// A sampler with no reading yet.
    pub fn new() -> ProcessSampler {
        ProcessSampler { last: None }
    }

    /// The process' CPU and memory use now (GPU use is the platform's to
    /// add).
    pub fn sample(&mut self) -> ProcessSample {
        let now = Instant::now();
        let cpu = cpu_time().and_then(|used| {
            let (previous, at) = self.last.replace((used, now))?;
            let wall = now.duration_since(at).as_secs_f32();
            (wall > 0.0).then(|| used.saturating_sub(previous).as_secs_f32() / wall * 100.0)
        });
        ProcessSample {
            cpu,
            memory: memory(),
            gpu: None,
        }
    }
}

/// The CPU time (user and system) the process used so far.
#[cfg(unix)]
fn cpu_time() -> Option<Duration> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: `usage` is a buffer of the layout the call fills.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: a zero return means the call filled the buffer.
    let usage = unsafe { usage.assume_init() };
    let time = |t: libc::timeval| Duration::new(t.tv_sec as u64, t.tv_usec as u32 * 1000);
    Some(time(usage.ru_utime) + time(usage.ru_stime))
}

#[cfg(windows)]
fn cpu_time() -> Option<Duration> {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: the pseudo handle of this process and four buffers the call fills.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    // FILETIME counts 100 ns.
    let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
    (ok != 0).then(|| Duration::from_nanos((ticks(kernel) + ticks(user)) * 100))
}

#[cfg(not(any(unix, windows)))]
fn cpu_time() -> Option<Duration> {
    None
}

/// The physical footprint (`proc_pid_rusage`): the dirty and compressed
/// memory the process owns, what Activity Monitor shows and what the system
/// judges it by under memory pressure (unlike the resident size, it leaves
/// out the frameworks' clean pages every process maps).
#[cfg(target_vendor = "apple")]
fn memory() -> Option<u64> {
    unsafe extern "C" {
        // libSystem's (libproc) on every Apple platform; the `libc` crate
        // declares it for macOS only.
        fn proc_pid_rusage(
            pid: libc::c_int,
            flavor: libc::c_int,
            buffer: *mut libc::rusage_info_t,
        ) -> libc::c_int;
    }
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::uninit();
    // SAFETY: `info` is a buffer of exactly the layout `RUSAGE_INFO_V2`
    // names, the only thing the call writes.
    let status = unsafe {
        proc_pid_rusage(
            std::process::id() as libc::c_int,
            libc::RUSAGE_INFO_V2,
            info.as_mut_ptr().cast::<libc::rusage_info_t>(),
        )
    };
    // SAFETY: a zero return means the call filled the buffer.
    (status == 0).then(|| unsafe { info.assume_init() }.ri_phys_footprint)
}

/// The resident set (`/proc/self/statm`'s second field, in pages).
#[cfg(any(target_os = "linux", target_os = "android"))]
fn memory() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    // SAFETY: a plain query of the page size.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    Some(pages * u64::try_from(page).ok()?)
}

/// The working set (resident memory), as on Linux.
#[cfg(windows)]
fn memory() -> Option<u64> {
    use windows_sys::Win32::System::{
        ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
        Threading::GetCurrentProcess,
    };
    // SAFETY: all-integer struct, zero is a valid value.
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: the pseudo handle of this process and a buffer of the size `cb` names.
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
    (ok != 0).then_some(counters.WorkingSetSize as u64)
}

#[cfg(not(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    windows
)))]
fn memory() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    #[test]
    fn stat_of_samples() {
        let stat = Stat::of((1..=20).map(ms));
        assert_eq!(stat.mean, Duration::from_micros(10_500));
        assert_eq!(stat.p50, ms(10));
        assert_eq!(stat.p95, ms(19));
        assert_eq!(stat.max, ms(20));
        assert_eq!(Stat::of(std::iter::empty()), Stat::default());
    }

    #[test]
    fn frames_are_refreshes_that_changed_something() {
        let monitor = PerfMonitor::new();
        let start = Instant::now();
        let period = Duration::from_micros(8333);
        for i in 0..(WARMUP + 10) {
            monitor.record_work(ms(1), true);
            // Work that changed nothing is part of the next frame's cost.
            monitor.record_work(ms(1), false);
            monitor.vsync(start + period * i, period);
            // A refresh with nothing new is not a frame.
            monitor.vsync(start + period * i + period / 2, period);
        }
        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.frames.len(), 10);
        assert_eq!(snapshot.frame.mean, ms(2));
        assert!((snapshot.refresh_rate.unwrap() - 120.0).abs() < 0.5);
        // 2ms frames could run at 500 per second, but not on a 120 Hz display.
        assert!((snapshot.max_fps - 120.0).abs() < 0.5);
        assert_eq!(snapshot.dropped, 0.0);
    }

    #[test]
    fn slow_frames_are_dropped_ones() {
        let monitor = PerfMonitor::new();
        let start = Instant::now();
        let period = ms(16);
        for i in 0..(WARMUP + 4) {
            monitor.record_work(if i % 2 == 0 { ms(20) } else { ms(1) }, true);
            monitor.vsync(start + period * i, period);
        }
        assert_eq!(monitor.snapshot().dropped, 0.5);
    }

    #[test]
    fn commits_after_warmup() {
        let monitor = PerfMonitor::new();
        for _ in 0..(WARMUP + 3) {
            monitor.record_commit(CommitTiming {
                js: ms(1),
                layout: ms(2),
                ops: 3,
                items: 4,
            });
        }
        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.commits, 3.0);
        assert_eq!(snapshot.js.mean, ms(1));
        assert_eq!(snapshot.layout.p95, ms(2));
        assert_eq!(snapshot.items, 4.0);
    }

    #[test]
    fn process_sample_reads_memory() {
        let mut sampler = ProcessSampler::new();
        let first = sampler.sample();
        assert_eq!(first.cpu, None);
        #[cfg(any(target_vendor = "apple", target_os = "linux"))]
        assert!(first.memory.is_some_and(|m| m > 0));
        std::thread::sleep(ms(5));
        #[cfg(unix)]
        assert!(sampler.sample().cpu.is_some());
    }
}
