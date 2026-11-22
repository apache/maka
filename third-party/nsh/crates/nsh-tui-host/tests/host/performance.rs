#[cfg(not(debug_assertions))]
use std::time::Duration;
use std::{
    cell::RefCell,
    io::{self, Write},
    rc::Rc,
    time::Instant,
};

use nsh_platform_tui::{AppOptions, AppView, MeasuredBackend, MeasuredWriter};
#[cfg(not(debug_assertions))]
use nsh_platform_tui::{Bundle, FrameMetrics, Handled, Input, MouseInput, MouseKind};
use ratatui_core::{
    backend::{Backend, ClearType, TestBackend, WindowSize},
    buffer::Cell,
    layout::{Position, Size},
    terminal::Terminal,
};
use ratatui_crossterm::CrosstermBackend;

#[derive(Clone, Default)]
pub(super) struct Capture(pub(super) Rc<RefCell<Vec<u8>>>);
impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// The exact Cell diff reaches both ratatui's in-memory backend and the real ANSI encoder.
// Only the encoder's writer is substituted; nothing requires a TTY or terminal queries.
pub(super) struct MemoryTerminal {
    pub(super) screen: TestBackend,
    pub(super) ansi: CrosstermBackend<MeasuredWriter<Capture>>,
}
impl Backend for MemoryTerminal {
    type Error = io::Error;
    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        let cells: Vec<_> = content.collect();
        self.screen.draw(cells.iter().copied()).unwrap();
        self.ansi.draw(cells.into_iter())
    }
    fn hide_cursor(&mut self) -> io::Result<()> {
        self.ansi.hide_cursor()
    }
    fn show_cursor(&mut self) -> io::Result<()> {
        self.ansi.show_cursor()
    }
    fn get_cursor_position(&mut self) -> io::Result<Position> {
        Ok(self.screen.get_cursor_position().unwrap())
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        self.ansi.set_cursor_position(position)
    }
    fn clear(&mut self) -> io::Result<()> {
        self.screen.clear().unwrap();
        self.ansi.clear()
    }
    fn clear_region(&mut self, region: ClearType) -> io::Result<()> {
        self.screen.clear_region(region).unwrap();
        self.ansi.clear_region(region)
    }
    fn size(&self) -> io::Result<Size> {
        Ok(self.screen.size().unwrap())
    }
    fn window_size(&mut self) -> io::Result<WindowSize> {
        Ok(self.screen.window_size().unwrap())
    }
    fn flush(&mut self) -> io::Result<()> {
        Backend::flush(&mut self.ansi)
    }
}

type TestTerminal = Terminal<MeasuredBackend<MemoryTerminal>>;

fn terminal(view: &AppView, capture: Capture) -> TestTerminal {
    Terminal::new(view.measure_backend(MemoryTerminal {
        screen: TestBackend::new(200, 60),
        ansi: CrosstermBackend::new(view.measure_writer(capture)),
    }))
    .unwrap()
}

#[test]
fn performance_counts_encoded_output_and_stops_refreshing_after_idle() {
    let mut options = AppOptions::default();
    options.fps = true;
    let mut view = AppView::new(options);
    let capture = Capture::default();
    let mut terminal = terminal(&view, capture.clone());
    capture.0.borrow_mut().clear();
    view.draw_terminal(&mut terminal).unwrap();
    let sample = view.frame_metrics().unwrap();
    assert_eq!(sample.bytes, Some(capture.0.borrow().len() as u64));
    assert!(sample.bytes.unwrap() > sample.cells.unwrap());
    // Wait for the single idle refresh, not for a recurring HUD frame loop.
    let due = view.next_frame_deadline().unwrap();
    std::thread::sleep(due.saturating_duration_since(Instant::now()));
    view.draw_terminal(&mut terminal).unwrap();
    assert!(view.next_frame_deadline().is_none());
    let screen = &terminal.backend().inner().screen;
    let contents: String = screen.buffer().content.iter().map(|c| c.symbol()).collect();
    assert!(contents.contains("idle"), "{contents}");
    view.set_fps_monitor(false);
    view.draw_terminal(&mut terminal).unwrap();
    assert!(view.frame_metrics().is_none());
}

#[cfg(not(debug_assertions))]
fn text(terminal: &TestTerminal) -> String {
    terminal
        .backend()
        .inner()
        .screen
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect()
}

#[cfg(not(debug_assertions))]
fn draw(view: &mut AppView, terminal: &mut TestTerminal, capture: &Capture) -> FrameMetrics {
    capture.0.borrow_mut().clear();
    view.draw_terminal(terminal).unwrap();
    view.frame_metrics().unwrap()
}

#[test]
#[cfg(not(debug_assertions))]
#[ignore = "release-mode terminal scrolling baseline"]
fn bench_terminal_scroll() {
    const FRAMES: usize = 240;
    const WARMUP: usize = 20;
    const BUDGET: Duration = Duration::from_millis(4);
    let fixtures =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/performance");
    let mut over_budget = Vec::new();
    for (name, initial) in [
        ("LongList", "500 rows in one scroll view"),
        ("DataTable", "R1 C1"),
    ] {
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: fixtures.join(format!("{name}.tsx")),
            minify: false,
            split: false,
            ui_sets: AppOptions::default()
                .ui_sets
                .into_iter()
                .map(Into::into)
                .collect(),
            ..Default::default()
        })
        .unwrap();
        let mut options = AppOptions::default();
        options.fps = true;
        options.cache = nsh_platform_tui::CacheOptions::off();
        let mut view = AppView::new(options);
        let capture = Capture::default();
        let mut terminal = terminal(&view, capture.clone());
        draw(&mut view, &mut terminal, &capture);
        view.load(Bundle::source(bundle.code)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !text(&terminal).contains(initial) {
            assert!(Instant::now() < deadline, "{name} did not mount");
            draw(&mut view, &mut terminal, &capture);
            std::thread::yield_now();
        }
        let mut samples = Vec::with_capacity(FRAMES);
        let mut costs = Vec::with_capacity(FRAMES);
        for frame in 0..FRAMES + WARMUP {
            let mut mouse = MouseInput::default();
            mouse.column = 100;
            mouse.row = 30;
            mouse.kind = MouseKind::Wheel {
                x: 0,
                y: if (frame / 100) % 2 == 0 { 1 } else { -1 },
            };
            assert_eq!(
                view.handle(Input::Mouse(mouse)),
                Handled::Yes,
                "{name} must scroll"
            );
            let sample = draw(&mut view, &mut terminal, &capture);
            if frame >= WARMUP {
                samples.push(sample);
                costs.push(sample.apply + sample.draw);
            }
            // Real cadence lets the engine deliver the scroll's batches before the next frame.
            // This wait and ANSI encoding are outside apply + draw, as in the live monitor.
            std::thread::sleep(Duration::from_millis(16));
        }
        assert!(
            !text(&terminal).contains(initial),
            "{name} must move away from its first row"
        );
        costs.sort_unstable();
        let median = costs[(FRAMES - 1) / 2];
        let p95 = costs[(FRAMES * 95).div_ceil(100) - 1];
        let mean_phase = |phase: fn(&FrameMetrics) -> Duration| {
            samples.iter().map(phase).sum::<Duration>().as_secs_f64() * 1000.0 / FRAMES as f64
        };
        let bytes = samples.iter().map(|s| s.bytes.unwrap()).sum::<u64>() as f64 / FRAMES as f64;
        let cells = samples.iter().map(|s| s.cells.unwrap()).sum::<u64>() as f64 / FRAMES as f64;
        println!(
            "{name}: 200x60 Cells, {FRAMES} frames, apply+draw median {:.3} ms p95 {:.3} ms; mean apply {:.3} draw {:.3} flush {:.3} ms; {bytes:.1} B/frame {cells:.1} Cells/frame; budget {}",
            median.as_secs_f64() * 1000.0,
            p95.as_secs_f64() * 1000.0,
            mean_phase(|s| s.apply),
            mean_phase(|s| s.draw),
            mean_phase(|s| s.flush),
            if p95 < BUDGET { "PASS" } else { "OVER" }
        );
        if p95 >= BUDGET {
            over_budget.push(name);
        }
    }
    assert!(
        over_budget.is_empty(),
        "apply + draw p95 exceeds 4 ms: {over_budget:?}; inspect phase means above"
    );
}

#[test]
fn idle_polling_sleeps_even_if_the_transport_returns_early() {
    use nsh_platform_tui::{RunEvent, run_app};
    let mut view = AppView::default();
    let mut terminal = terminal(&view, Capture::default());
    let mut polls = 0;
    let started = Instant::now();
    run_app(&mut terminal, &mut view, |wait| {
        assert!(
            !wait.is_zero(),
            "a settled surface must request a blocking wait"
        );
        polls += 1;
        Ok(if polls == 4 {
            RunEvent::Exit
        } else {
            RunEvent::Idle
        })
    })
    .unwrap();
    assert!(
        started.elapsed() >= std::time::Duration::from_millis(40),
        "early idle returns must not create a busy loop"
    );
}

#[test]
fn a_terminal_poll_error_stops_the_loop_without_retrying() {
    let mut view = AppView::default();
    let mut terminal = terminal(&view, Capture::default());
    let mut polls = 0;
    let result = nsh_platform_tui::run_app(&mut terminal, &mut view, |_| {
        polls += 1;
        Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "terminal disconnected",
        ))
    });
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    assert_eq!(polls, 1);
}
