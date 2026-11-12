//! The performance monitor ([`crate::AppOptions::fps`], `--fps`): an
//! on-screen panel with readings and a frame-cost chart; once a second, one `nsh::fps` line of what the surface's frames and commits
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
    /// The panel shows only the frame rate and CPU (a click toggles it; per
    /// window, for the session).
    collapsed: Cell<bool>,
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
            collapsed: Cell::new(false),
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

/// A native diagnostic overlay. It belongs to the monitor, never to the
/// app's layout, focus order or pointer targets.
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

/// Shows readings and the most recent [`CHART_FRAMES`] frame costs. Updating
/// at 2 Hz keeps the diagnostics readable without asking the app for
/// continuous frames. A click collapses the panel to the frame rate and CPU,
/// and expands it again.
pub(crate) fn show(overlay: &gtk::Overlay, fps: &Rc<Fps>) {
    let panel = gtk::DrawingArea::new();
    resize(&panel, fps.collapsed.get());
    panel.set_halign(gtk::Align::End);
    panel.set_valign(gtk::Align::Start);
    // Leave the app's title bar and native window controls uncovered.
    panel.set_margin_top(54);
    panel.set_margin_end(10);
    // Aligned to its corner, the panel is allocated only its own size: it
    // takes the clicks on itself and every other point reaches the app.
    panel.set_focusable(false);
    panel.set_cursor_from_name(Some("pointer"));
    panel.set_accessible_role(gtk::AccessibleRole::Presentation);
    let weak = Rc::downgrade(fps);
    panel.set_draw_func(move |_, cx, width, height| {
        if let Some(fps) = weak.upgrade() {
            let s = fps.monitor.snapshot();
            draw(cx, width as f64, height as f64, &s, fps.collapsed.get());
        }
    });
    let click = gtk::GestureClick::new();
    click.connect_pressed(|gesture, _, _, _| {
        gesture.set_state(gtk::EventSequenceState::Claimed);
    });
    let weak = Rc::downgrade(fps);
    click.connect_released(move |gesture, _, _, _| {
        let panel = gesture.widget().and_downcast::<gtk::DrawingArea>();
        if let (Some(fps), Some(panel)) = (weak.upgrade(), panel) {
            toggle(&fps, &panel);
        }
    });
    panel.add_controller(click);
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

/// The panel's size and inner padding (points), and its size collapsed: a
/// small pill holding the frame rate and the process' CPU.
const WIDTH: i32 = 288;
const HEIGHT: i32 = 96;
const PAD: f64 = 10.0;
const COLLAPSED_WIDTH: i32 = 128;
const COLLAPSED_HEIGHT: i32 = 24;

/// Collapses or expands the panel.
fn toggle(fps: &Fps, panel: &gtk::DrawingArea) {
    fps.collapsed.set(!fps.collapsed.get());
    resize(panel, fps.collapsed.get());
    panel.queue_draw();
}

/// Sizes the panel for its state.
fn resize(panel: &gtk::DrawingArea, collapsed: bool) {
    let (width, height) = if collapsed {
        (COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
    } else {
        (WIDTH, HEIGHT)
    };
    panel.set_content_width(width);
    panel.set_content_height(height);
}

/// How many frames the curve shows, edge to edge, and how high a frame
/// that takes a whole refresh rises from the bottom: frames within budget
/// stay under the text, slow ones rise into it (three refreshes reach the
/// top).
const CHART_FRAMES: usize = 120;
const BUDGET_RISE: f64 = 14.0;

/// Text colors: values bright, labels and units muted.
const VALUE: (f64, f64, f64) = (0.93, 0.94, 0.95);
const MUTED: (f64, f64, f64) = (0.56, 0.58, 0.62);

/// The two rows of readings under the frame rate, as label / value cells:
/// times in milliseconds (the first row, its unit once at its end), then
/// what the process and the app hold.
fn cells(s: &PerfSnapshot) -> [[(&'static str, String); 4]; 2] {
    let ms = |d: Duration| format!("{:.2}", d.as_secs_f64() * 1e3);
    let none = || "—".to_owned();
    let memory = s.memory;
    [
        [
            ("frame", ms(s.frame.mean)),
            ("p95", ms(s.frame.p95)),
            ("js", ms(s.js.mean)),
            ("core", ms(s.layout.mean)),
        ],
        [
            (
                "cpu",
                s.process.cpu.map_or_else(none, |c| format!("{c:.0}%")),
            ),
            ("mem", s.process.memory.map_or_else(none, bytes)),
            ("heap", memory.map_or_else(none, |m| bytes(m.js_heap))),
            ("nodes", memory.map_or_else(none, |m| count(m.nodes))),
        ],
    ]
}

/// A size, short: `85 MB`, `1.2 GB`.
fn bytes(n: u64) -> String {
    if n < 1_000_000_000 {
        format!("{:.0} MB", n as f64 / 1e6)
    } else {
        format!("{:.1} GB", n as f64 / 1e9)
    }
}

/// A count, short: `950`, `12.3k`, `4.1M`.
fn count(n: u64) -> String {
    match n {
        0..1_000 => n.to_string(),
        1_000..1_000_000 => format!("{:.1}k", n as f64 / 1e3),
        _ => format!("{:.1}M", n as f64 / 1e6),
    }
}

/// Draws `text` with its baseline at `y`, starting at `x`, or ending there
/// when `end` (right-aligned); returns its advance.
fn text(cx: &cairo::Context, x: f64, y: f64, s: &str, end: bool) -> f64 {
    let advance = cx.text_extents(s).map_or(0.0, |e| e.x_advance());
    cx.move_to(if end { x - advance } else { x }, y);
    let _ = cx.show_text(s);
    advance
}

fn font(cx: &cairo::Context, family: &str, weight: cairo::FontWeight, size: f64) {
    cx.select_font_face(family, cairo::FontSlant::Normal, weight);
    cx.set_font_size(size);
}

fn color(cx: &cairo::Context, (r, g, b): (f64, f64, f64)) {
    cx.set_source_rgb(r, g, b);
}

/// A rounded rectangle's path.
fn rounded(cx: &cairo::Context, x: f64, y: f64, w: f64, h: f64, radius: f64) {
    use std::f64::consts::{FRAC_PI_2, PI};
    cx.new_sub_path();
    cx.arc(x + w - radius, y + radius, radius, -FRAC_PI_2, 0.0);
    cx.arc(x + w - radius, y + h - radius, radius, 0.0, FRAC_PI_2);
    cx.arc(x + radius, y + h - radius, radius, FRAC_PI_2, PI);
    cx.arc(x + radius, y + radius, radius, PI, PI + FRAC_PI_2);
    cx.close_path();
}

/// The panel: the frame rate large over the display's rate and two rows of
/// readings, over the latest frames' cost as its background ([`curve`]). A
/// dark panel in either appearance, as diagnostics read best. `collapsed`:
/// only the frame rate and the process' CPU, on a small pill.
fn draw(cx: &cairo::Context, width: f64, height: f64, s: &PerfSnapshot, collapsed: bool) {
    let _ = cx.save();
    cx.set_source_rgba(0.07, 0.075, 0.085, 0.92);
    if collapsed {
        // The frame rate and the process' CPU, centered on the pill: each
        // figure bright, its unit muted after it.
        rounded(cx, 0.0, 0.0, width, height, height / 2.0);
        let _ = cx.fill();
        let cpu = s
            .process
            .cpu
            .map_or_else(|| "—".to_owned(), |c| format!("{c:.0}%"));
        let pairs = [(format!("{:.0}", s.fps), "fps"), (cpu, "cpu")];
        let measure = |s: &str, weight, size| {
            font(cx, "sans", weight, size);
            cx.text_extents(s).map_or(0.0, |e| e.x_advance())
        };
        let (unit_gap, pair_gap) = (3.0, 10.0);
        let widths: Vec<(f64, f64)> = pairs
            .iter()
            .map(|(value, unit)| {
                (
                    measure(value, cairo::FontWeight::Bold, 13.0),
                    measure(unit, cairo::FontWeight::Normal, 9.0),
                )
            })
            .collect();
        let total: f64 = widths.iter().map(|(v, u)| v + unit_gap + u).sum::<f64>()
            + pair_gap * (pairs.len() - 1) as f64;
        let mut x = ((width - total) / 2.0).max(0.0).round();
        let baseline = (height / 2.0 + 4.5).round();
        for ((value, unit), (advance, unit_advance)) in pairs.iter().zip(widths) {
            font(cx, "sans", cairo::FontWeight::Bold, 13.0);
            color(cx, VALUE);
            text(cx, x, baseline, value, false);
            font(cx, "sans", cairo::FontWeight::Normal, 9.0);
            color(cx, MUTED);
            text(cx, x + advance + unit_gap, baseline, unit, false);
            x += advance + unit_gap + unit_advance + pair_gap;
        }
        let _ = cx.restore();
        return;
    }
    rounded(cx, 0.0, 0.0, width, height, 10.0);
    let _ = cx.save();
    cx.clip_preserve();
    let _ = cx.fill();
    curve(cx, width, height, s);
    let _ = cx.restore();
    let right = width - PAD;

    // The frame rate, then the display's rate at the right.
    font(cx, "sans", cairo::FontWeight::Bold, 22.0);
    color(cx, VALUE);
    let advance = text(cx, PAD, 32.0, &format!("{:.0}", s.fps), false);
    font(cx, "sans", cairo::FontWeight::Normal, 11.0);
    color(cx, MUTED);
    text(cx, PAD + advance + 4.0, 32.0, "fps", false);
    let rate = s
        .refresh_rate
        .map_or_else(|| "— Hz".to_owned(), |r| format!("{r:.0} Hz"));
    text(cx, right, 32.0, &rate, true);

    // Readings on a shared four-column grid: label at a cell's start,
    // value right-aligned at its end; the first row's unit after it.
    let unit = 14.0;
    let column = (width - 2.0 * PAD - unit) / 4.0;
    for (row, cells) in cells(s).iter().enumerate() {
        let y = 52.0 + row as f64 * 16.0;
        for (i, (label, value)) in cells.iter().enumerate() {
            let x = PAD + i as f64 * column;
            font(cx, "sans", cairo::FontWeight::Normal, 9.0);
            color(cx, MUTED);
            text(cx, x, y, label, false);
            font(cx, "monospace", cairo::FontWeight::Normal, 9.5);
            color(cx, VALUE);
            text(cx, x + column - 4.0, y, value, true);
        }
        if row == 0 {
            font(cx, "sans", cairo::FontWeight::Normal, 9.0);
            color(cx, MUTED);
            text(cx, right, y, "ms", true);
        }
    }

    let _ = cx.restore();
}

/// How far a frame of `ms` rises from the panel's bottom: within the budget
/// up to [`BUDGET_RISE`], beyond it towards the top, reached at three
/// refreshes.
fn rise(ms: f64, budget: f64, height: f64) -> f64 {
    if ms <= budget {
        BUDGET_RISE * ms / budget
    } else {
        let over = (ms - budget) / (2.0 * budget);
        (BUDGET_RISE + (height - BUDGET_RISE) * over).min(height - 4.0)
    }
}

/// The latest frames' cost as a smooth curve with a soft fill under it,
/// the panel's background layer (drawn clipped to it, under the text):
/// newest at the right edge, green within the budget and amber above it.
fn curve(cx: &cairo::Context, width: f64, height: f64, s: &PerfSnapshot) {
    let count = s.frames.len().min(CHART_FRAMES);
    if count < 2 {
        return;
    }
    let budget = 1000.0 / s.refresh_rate.unwrap_or(60.0).max(1.0) as f64;
    let step = width / (CHART_FRAMES - 1) as f64;
    let points: Vec<(f64, f64)> = s.frames[s.frames.len() - count..]
        .iter()
        .enumerate()
        .map(|(i, frame)| {
            let ms = frame.as_secs_f64() * 1e3;
            let x = width - (count - 1 - i) as f64 * step;
            (x, height - rise(ms, budget, height))
        })
        .collect();
    // Catmull-Rom segments as Béziers, their control points kept between
    // the segment's ends so the curve never swings past a sample.
    let path = |cx: &cairo::Context| {
        cx.line_to(points[0].0, points[0].1);
        for i in 0..count - 1 {
            let (p0, p1) = (points[i.saturating_sub(1)], points[i]);
            let (p2, p3) = (points[i + 1], points[(i + 2).min(count - 1)]);
            let (low, high) = (p1.1.min(p2.1), p1.1.max(p2.1));
            cx.curve_to(
                p1.0 + (p2.0 - p0.0) / 6.0,
                (p1.1 + (p2.1 - p0.1) / 6.0).clamp(low, high),
                p2.0 - (p3.0 - p1.0) / 6.0,
                (p2.1 - (p3.1 - p1.1) / 6.0).clamp(low, high),
                p2.0,
                p2.1,
            );
        }
    };
    // Green up to the budget's height, amber over it.
    let edge = height - BUDGET_RISE;
    let gradient = |line: f64, fill: f64| {
        let g = cairo::LinearGradient::new(0.0, edge + 1.0, 0.0, edge - 5.0);
        g.add_color_stop_rgba(0.0, 0.42, 0.80, 0.58, if line > 0.0 { line } else { fill });
        g.add_color_stop_rgba(
            1.0,
            0.98,
            0.72,
            0.28,
            if line > 0.0 { line } else { fill * 1.4 },
        );
        g
    };
    cx.new_path();
    cx.move_to(points[0].0, height);
    path(cx);
    cx.line_to(width, height);
    cx.close_path();
    let _ = cx.set_source(gradient(0.0, 0.16));
    let _ = cx.fill();
    cx.new_path();
    cx.move_to(points[0].0, points[0].1);
    path(cx);
    cx.set_line_width(1.25);
    cx.set_line_join(cairo::LineJoin::Round);
    let _ = cx.set_source(gradient(0.7, 0.0));
    let _ = cx.stroke();
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
    log::info!(target: nsh_engine::perf::LOG_TARGET, "{}", line(&fps.monitor.snapshot(), &phases, &drains));
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
            assert!(panel.can_target());
            assert!(!panel.is_focusable());
            // A click collapses it to a pill and expands it again.
            toggle(&fps, &panel);
            assert_eq!(
                (panel.content_width(), panel.content_height()),
                (COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
            );
            toggle(&fps, &panel);
            assert_eq!(
                (panel.content_width(), panel.content_height()),
                (WIDTH, HEIGHT)
            );
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
    fn frame_cost_curve_is_the_background_and_rises_only_when_slow() {
        let render = |frames: &[u64]| {
            let mut snapshot = PerfSnapshot::default();
            snapshot.refresh_rate = Some(60.0);
            snapshot.frames = frames.iter().map(|&ms| Duration::from_millis(ms)).collect();
            let mut image =
                cairo::ImageSurface::create(cairo::Format::ARgb32, WIDTH, HEIGHT).unwrap();
            let cx = cairo::Context::new(&image).unwrap();
            draw(&cx, WIDTH as f64, HEIGHT as f64, &snapshot, false);
            drop(cx);
            let stride = image.stride() as usize;
            let pixels = image.data().unwrap().to_vec();
            move |x: usize, y: usize| {
                let offset = y * stride + x * 4;
                u32::from_ne_bytes(pixels[offset..offset + 4].try_into().unwrap())
            }
        };
        let empty = render(&[]);
        let fast = render(&[8; CHART_FRAMES]);
        let slow = render(&[[8; CHART_FRAMES - 2].as_slice(), &[40, 40]].concat());
        // Fast frames tint the bottom edge to edge, green, and leave the
        // text area as it is.
        let (bottom, green) = (
            HEIGHT as usize - 2,
            fast(WIDTH as usize / 2, HEIGHT as usize - 2),
        );
        assert_ne!(fast(12, bottom), empty(12, bottom));
        assert_ne!(
            fast(WIDTH as usize - 12, bottom),
            empty(WIDTH as usize - 12, bottom)
        );
        assert!((green >> 8 & 255) > (green >> 16 & 255) + 10);
        assert_eq!(fast(150, 40), empty(150, 40));
        assert_eq!(fast(WIDTH as usize - 3, 50), empty(WIDTH as usize - 3, 50));
        // Slow newest frames rise into it at the right edge.
        assert_ne!(slow(WIDTH as usize - 2, 50), empty(WIDTH as usize - 2, 50));
    }

    #[test]
    fn frames_within_budget_stay_under_the_text() {
        let (budget, height) = (16.7, HEIGHT as f64);
        assert!(rise(budget, budget, height) <= BUDGET_RISE);
        // The second row of readings ends near 70; a fast frame stays below.
        assert!(height - rise(budget, budget, height) > 72.0);
        assert!(height - rise(budget * 2.0, budget, height) < 52.0);
        assert!(rise(budget * 10.0, budget, height) < height);
    }

    #[test]
    #[allow(
        clippy::field_reassign_with_default,
        reason = "PerfSnapshot is non-exhaustive outside nsh-engine"
    )]
    fn the_collapsed_panel_is_a_pill_of_the_frame_rate_and_cpu() {
        let (w, h) = (COLLAPSED_WIDTH, COLLAPSED_HEIGHT);
        let mut image = cairo::ImageSurface::create(cairo::Format::ARgb32, w, h).unwrap();
        let cx = cairo::Context::new(&image).unwrap();
        let mut snapshot = PerfSnapshot::default();
        snapshot.fps = 134.0;
        snapshot.refresh_rate = Some(144.0);
        snapshot.process.cpu = Some(24.0);
        draw(&cx, w as f64, h as f64, &snapshot, true);
        drop(cx);
        let stride = image.stride() as usize;
        let pixels = image.data().unwrap();
        let alpha = |x: usize, y: usize| pixels[y * stride + x * 4 + 3];
        // Round ends: the corners stay clear, the middle of an end is filled.
        assert_eq!(alpha(1, 1), 0);
        assert_eq!(alpha(w as usize - 2, h as usize - 2), 0);
        assert!(alpha(2, h as usize / 2) > 200);
        // Both figures are drawn bright across the middle of the pill: one
        // in each half.
        let red = |x: usize, y: usize| pixels[y * stride + x * 4 + 2];
        let half = w as usize / 2;
        assert!((0..half).any(|x| red(x, h as usize / 2) > 150));
        assert!((half..w as usize).any(|x| red(x, h as usize / 2) > 150));
    }

    #[test]
    #[allow(
        clippy::field_reassign_with_default,
        reason = "PerfSnapshot is non-exhaustive outside nsh-engine"
    )]
    fn readings_show_what_the_process_and_the_app_hold() {
        let mut snapshot = PerfSnapshot::default();
        let [times, held] = cells(&snapshot);
        assert_eq!(times[0], ("frame", "0.00".to_owned()));
        assert!(held.iter().all(|(_, value)| value == "—"));
        snapshot.process.cpu = Some(57.0);
        snapshot.process.memory = Some(1_234_000_000);
        snapshot.memory = Some(nsh_engine::perf::MemorySample {
            js_heap: 85_000_000,
            nodes: 6_100,
            ..Default::default()
        });
        let values = cells(&snapshot)[1].clone().map(|(_, value)| value);
        assert_eq!(values, ["57%", "1.2 GB", "85 MB", "6.1k"]);
    }
}
