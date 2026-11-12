//! Opt-in terminal frame timings. Transport adapters count successful output,
//! and the HUD's own refreshes never enter the application's frame history.

use std::{
    cell::Cell,
    collections::VecDeque,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_engine::perf::PerfMonitor;
use ratatui_core::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
};

mod output;
pub use output::{MeasuredBackend, MeasuredWriter};

const HISTORY: usize = 120;
const REFRESH: Duration = Duration::from_secs(1);

/// Work and terminal output of one completed frame. Transport counters include the HUD.
#[derive(Clone, Copy, Debug, Default)]
#[non_exhaustive]
pub struct FrameMetrics {
    /// Time applying queued work, before painting.
    pub apply: Duration,
    /// Time painting the surface into ratatui's buffer.
    pub draw: Duration,
    /// Time diffing, encoding and flushing the terminal after painting.
    pub flush: Duration,
    /// Bytes successfully written, when a measured writer is installed.
    pub bytes: Option<u64>,
    /// Changed Cells handed to the terminal backend, when it is measured.
    pub cells: Option<u64>,
}

#[derive(Default)]
pub(crate) struct Output {
    pub(crate) enabled: Cell<bool>,
    pub(crate) bytes: Cell<Option<u64>>,
    pub(crate) cells: Cell<Option<u64>>,
    /// The linked Cells of the frame last drawn, which the backend wraps
    /// in their hyperlinks (`crate::link`).
    pub(crate) links: std::cell::RefCell<crate::link::Links>,
}

pub(crate) struct Monitor {
    pub(crate) engine: Arc<PerfMonitor>,
    pub(crate) refresh: Option<Instant>,
    pub(crate) pending: FrameMetrics,
    pub(crate) last: Option<FrameMetrics>,
    frames: VecDeque<(Instant, FrameMetrics)>,
    line: String,
}

impl Monitor {
    pub(crate) fn new() -> Self {
        Self {
            engine: Arc::new(PerfMonitor::new()),
            refresh: Some(Instant::now()),
            pending: FrameMetrics::default(),
            last: None,
            frames: VecDeque::with_capacity(HISTORY),
            line: String::new(),
        }
    }

    pub(crate) fn finish(&mut self, at: Instant, sample: FrameMetrics, app_frame: bool) {
        self.last = Some(sample);
        if app_frame {
            if self.frames.len() == HISTORY {
                self.frames.pop_front();
            }
            self.frames.push_back((at, sample));
            self.engine
                .record_work(sample.apply + sample.draw + sample.flush, true);
            self.engine.vsync(at, Duration::ZERO);
            self.refresh.get_or_insert(at + REFRESH);
        }
    }

    pub(crate) fn draw(&mut self, area: Rect, buffer: &mut Buffer) {
        let now = Instant::now();
        if self.line.is_empty() || self.refresh.is_some_and(|due| due <= now) {
            let recent: Vec<_> = self
                .frames
                .iter()
                .filter(|(at, _)| now.duration_since(*at) < REFRESH)
                .collect();
            let rate = if recent.is_empty() {
                "idle".to_owned()
            } else {
                let fps = self.engine.snapshot().fps;
                format!("{fps:.0}fps")
            };
            let mut totals: Vec<_> = self
                .frames
                .iter()
                .map(|(_, s)| s.apply + s.draw + s.flush)
                .collect();
            totals.sort_unstable();
            let count = self.frames.len().max(1) as u32;
            let mean = |f: fn(&FrameMetrics) -> Duration| {
                self.frames.iter().map(|(_, s)| f(s)).sum::<Duration>() / count
            };
            let p95 = totals
                .get((totals.len() * 95).div_ceil(100).saturating_sub(1))
                .copied()
                .unwrap_or_default();
            let output = |f: fn(&FrameMetrics) -> Option<u64>| {
                let values: Vec<_> = self.frames.iter().filter_map(|(_, s)| f(s)).collect();
                if values.is_empty() {
                    "-".to_owned()
                } else {
                    format!(
                        "{:.0}",
                        values.iter().sum::<u64>() as f64 / values.len() as f64
                    )
                }
            };
            let ms = |d: Duration| d.as_secs_f64() * 1000.0;
            self.line = format!(
                "{rate} {:.2}ms p95 {:.2} apply {:.2} draw {:.2} flush {:.2} {}B/f {}Cells/f",
                ms(totals.iter().sum::<Duration>() / count),
                ms(p95),
                ms(mean(|s| s.apply)),
                ms(mean(|s| s.draw)),
                ms(mean(|s| s.flush)),
                output(|s| s.bytes),
                output(|s| s.cells)
            );
            log::info!(target: nsh_engine::perf::LOG_TARGET, "{}", self.line);
            // One final idle update, then no timer until app work resumes.
            self.refresh = (!recent.is_empty()).then_some(now + REFRESH);
        }
        if area.is_empty() {
            return;
        }
        let width = self.line.len().min(usize::from(area.width)) as u16;
        buffer.set_stringn(
            area.right() - width,
            area.top(),
            &self.line,
            usize::from(width),
            Style::default().fg(Color::White).bg(Color::Black),
        );
    }
}

pub(crate) type SharedOutput = Rc<Output>;
