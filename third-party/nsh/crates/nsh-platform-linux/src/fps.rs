//! The performance monitor ([`crate::AppOptions::fps`], `--fps`): an
//! on-screen panel with readings and a frame-cost chart; once a second, one `nsh::perf` line of what the surface's frames and commits
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

use gtk4::{self as gtk, cairo, gdk, glib, prelude::*};
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
    hud: RefCell<Option<Hud>>,
}

impl Drop for Fps {
    fn drop(&mut self) {
        self.hud.get_mut().take();
        MEASURING.set(false);
    }
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
            hud: RefCell::default(),
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

/// A native diagnostic overlay, matching the macOS monitor. It belongs to
/// the monitor, never to the app's layout, focus order or pointer targets.
struct Hud {
    panel: gtk::DrawingArea,
    overlay: glib::WeakRef<gtk::Overlay>,
    timer: Option<glib::SourceId>,
}

impl Drop for Hud {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.remove();
        }
        if let Some(overlay) = self.overlay.upgrade() {
            overlay.remove_overlay(&self.panel);
        }
    }
}

/// Shows readings and the most recent 120 frame costs. Updating at 2 Hz
/// keeps the diagnostics readable without asking the app for continuous frames.
pub(crate) fn show(overlay: &gtk::Overlay, fps: &Rc<Fps>) {
    let panel = gtk::DrawingArea::new();
    panel.set_content_width(262);
    panel.set_content_height(186);
    panel.set_halign(gtk::Align::End);
    panel.set_valign(gtk::Align::Start);
    // Leave the app's title bar and native window controls uncovered.
    panel.set_margin_top(54);
    panel.set_margin_end(10);
    panel.set_can_target(false);
    panel.set_focusable(false);
    panel.set_accessible_role(gtk::AccessibleRole::Presentation);
    let weak = Rc::downgrade(fps);
    panel.set_draw_func(move |_, cx, width, height| {
        if let Some(fps) = weak.upgrade() {
            draw(cx, width as f64, height as f64, &fps.monitor.snapshot());
        }
    });
    overlay.add_overlay(&panel);
    let weak = Rc::downgrade(fps);
    let timer = glib::timeout_add_local(Duration::from_millis(500), move || {
        if let Some(fps) = weak.upgrade() {
            if let Some(hud) = fps.hud.borrow().as_ref() {
                // No need to sample or draw a hidden / minimized app.
                if hud.panel.is_mapped() {
                    fps.monitor.set_process(fps.sampler.borrow_mut().sample());
                    hud.panel.queue_draw();
                }
            }
            glib::ControlFlow::Continue
        } else {
            glib::ControlFlow::Break
        }
    });
    *fps.hud.borrow_mut() = Some(Hud {
        panel,
        overlay: overlay.downgrade(),
        timer: Some(timer),
    });
}

fn readings(s: &PerfSnapshot) -> [String; 5] {
    [
        format!(
            "FPS {:3.0} / {:.0} Hz",
            s.fps,
            s.refresh_rate.unwrap_or(60.0)
        ),
        format!(
            "Frame {:5.2}  p95 {:5.2} ms",
            s.frame.mean.as_secs_f64() * 1e3,
            s.frame.p95.as_secs_f64() * 1e3
        ),
        format!(
            "JS    {:5.2}  Core {:5.2} ms",
            s.js.mean.as_secs_f64() * 1e3,
            s.layout.mean.as_secs_f64() * 1e3
        ),
        format!(
            "CPU {}  RSS {}",
            s.process.cpu.map_or("—".into(), |cpu| format!("{cpu:.0}%")),
            s.process
                .memory
                .map_or("—".into(), |m| format!("{:.1} MB", m as f64 / 1e6))
        ),
        format!(
            "Frame cost · budget {:.1} ms",
            1000.0 / s.refresh_rate.unwrap_or(60.0)
        ),
    ]
}

fn draw(cx: &cairo::Context, width: f64, height: f64, s: &PerfSnapshot) {
    // Diagnostic colors deliberately match macOS: a dark panel in either
    // appearance, with green / amber / red frame costs against the budget.
    let _ = cx.save();
    cx.set_source_rgb(0.06, 0.07, 0.08);
    let radius = 8.0;
    for (x, y, angle) in [
        (width - radius, radius, -std::f64::consts::FRAC_PI_2),
        (width - radius, height - radius, 0.0),
        (radius, height - radius, std::f64::consts::FRAC_PI_2),
        (radius, radius, std::f64::consts::PI),
    ] {
        cx.arc(x, y, radius, angle, angle + std::f64::consts::FRAC_PI_2);
    }
    cx.close_path();
    let _ = cx.fill();
    cx.select_font_face(
        "monospace",
        cairo::FontSlant::Normal,
        cairo::FontWeight::Normal,
    );
    cx.set_font_size(11.0);
    cx.set_source_rgb(0.94, 0.95, 0.96);
    for (i, line) in readings(s).iter().enumerate() {
        cx.move_to(8.0, 18.0 + i as f64 * 21.0);
        let _ = cx.show_text(line);
    }
    let (x, y, w, h) = (8.0, height - 72.0, width - 16.0, 48.0);
    cx.set_source_rgba(1.0, 1.0, 1.0, 0.08);
    cx.rectangle(x, y, w, h);
    let _ = cx.fill();
    let budget = 1000.0 / s.refresh_rate.unwrap_or(60.0).max(1.0) as f64;
    let bar = w / 120.0;
    let count = s.frames.len().min(120);
    for (i, frame) in s.frames.iter().skip(s.frames.len() - count).enumerate() {
        let ms = frame.as_secs_f64() * 1e3;
        let (r, g, b) = if ms <= budget / 2.0 {
            (0.30, 0.85, 0.45)
        } else if ms <= budget {
            (0.98, 0.75, 0.25)
        } else {
            (0.98, 0.35, 0.33)
        };
        cx.set_source_rgb(r, g, b);
        let cost = (ms / (budget * 2.0) * h).clamp(1.0, h);
        cx.rectangle(
            x + (120 - count + i) as f64 * bar,
            y + h - cost,
            (bar - 0.5).max(0.5),
            cost,
        );
        let _ = cx.fill();
    }
    cx.set_source_rgba(1.0, 1.0, 1.0, 0.5);
    cx.set_line_width(1.0);
    cx.move_to(x, y + h / 2.0);
    cx.line_to(x + w, y + h / 2.0);
    let _ = cx.stroke();
    cx.set_source_rgb(0.7, 0.72, 0.75);
    cx.set_font_size(10.0);
    cx.move_to(x, height - 8.0);
    let _ = cx.show_text("120 frames · newest →");
    let _ = cx.restore();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggling_the_monitor_removes_the_panel_and_timer() {
        crate::gtk_test::run(|| {
            let surface = crate::gtk_test::surface();
            let overlay = gtk::Overlay::new();
            overlay.set_child(Some(&surface.root));
            *surface.fps_overlay.borrow_mut() = overlay.downgrade();
            surface.enable_fps();
            let fps = surface.fps_for_test();
            let panel = fps.hud.borrow().as_ref().unwrap().panel.clone();
            assert!(panel.parent().is_some());
            assert!(!panel.can_target());
            assert!(!panel.is_focusable());
            // Re-enabling keeps a single panel and collector.
            surface.enable_fps();
            assert!(Rc::ptr_eq(&fps, &surface.fps_for_test()));
            let weak = Rc::downgrade(&fps);
            drop(fps);
            surface.disable_fps();
            assert!(weak.upgrade().is_none());
            assert!(panel.parent().is_none());
            surface.enable_fps();
            let next = surface
                .fps_for_test()
                .hud
                .borrow()
                .as_ref()
                .unwrap()
                .panel
                .clone();
            assert_ne!(panel, next);
            surface.disable_fps();
            assert!(next.parent().is_none());
        });
    }

    #[test]
    #[allow(
        clippy::field_reassign_with_default,
        reason = "PerfSnapshot is non-exhaustive outside nsh-engine"
    )]
    fn frame_cost_chart_draws_samples_and_the_budget_line() {
        let mut snapshot = PerfSnapshot::default();
        snapshot.refresh_rate = Some(60.0);
        snapshot.frames = vec![
            Duration::from_millis(2),
            Duration::from_millis(12),
            Duration::from_millis(28),
        ];
        let mut image = cairo::ImageSurface::create(cairo::Format::ARgb32, 262, 186).unwrap();
        let cx = cairo::Context::new(&image).unwrap();
        draw(&cx, 262.0, 186.0, &snapshot);
        drop(cx);
        let stride = image.stride() as usize;
        let pixels = image.data().unwrap();
        let pixel = |x: usize, y: usize| {
            let offset = y * stride + x * 4;
            u32::from_ne_bytes(pixels[offset..offset + 4].try_into().unwrap())
        };
        // Samples end at the chart's right edge; this red bar exceeds
        // the 16.7 ms budget. The line is also visible without any samples.
        let red = pixel(252, 130);
        assert!((red >> 16 & 255) > (red >> 8 & 255) * 2);
        assert_ne!(pixel(20, 138), pixel(20, 128));
    }
}
