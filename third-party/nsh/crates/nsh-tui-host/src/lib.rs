//! Standalone terminal transport for the Native Shell development host.

use std::{cell::RefCell, io, path::PathBuf, rc::Rc};

use clap::Parser;
use nsh_platform_tui::{AppOptions, AppView, Bundle, CellSize, Limits, RunEvent, run_app};
use ratatui_core::{
    backend::{Backend, TestBackend},
    terminal::Terminal,
};
use ratatui_crossterm::CrosstermBackend;

mod assets;
mod clipboard;
mod logging;
mod shutdown;
mod terminal;

pub use terminal::convert;

#[derive(Parser)]
#[command(
    about = "Run Native Shell in the terminal (C-h e opens logs; Ctrl+C copies a selection, else exits)"
)]
struct Args {
    #[arg(long, conflicts_with = "dev_server")]
    bundle: Option<PathBuf>,
    #[arg(long)]
    dev_server: Option<String>,
    #[arg(long, default_value = "8x16")]
    points_per_cell: CellSize,
    #[arg(long)]
    log_file: Option<PathBuf>,
    #[arg(long)]
    data_dir: Option<PathBuf>,
    #[arg(long)]
    trace: bool,
    /// Show frame timings and terminal output (C-h p toggles).
    #[arg(long)]
    fps: bool,
    /// Leave the mouse to the terminal (its own text selection) instead of capturing
    /// clicks, hover, dragging and the wheel.
    #[arg(long)]
    no_mouse: bool,

    /// Render to an in-memory terminal (used by nsh test).
    #[arg(long, requires = "dev_server")]
    headless: bool,
    /// Initial in-memory viewport in points, rounded up to whole Cells.
    #[arg(long, requires = "headless")]
    window_size: Option<CellSize>,
}

/// Parses host arguments and runs the selected bundle. The binary owns logging and diagnostics.
pub fn main() -> io::Result<()> {
    main_with_options(AppOptions::default())
}

/// Runs the host with an app's registered UI sets and optional Rust root.
pub fn main_with_options(mut options: AppOptions) -> io::Result<()> {
    let args = Args::parse();
    let log_file = args.log_file.clone().unwrap_or_else(|| {
        std::env::temp_dir().join(format!("nsh-tui-host-{}.log", std::process::id()))
    });
    logging::init(&log_file, args.trace)?;
    options.limits = Limits::standalone();
    options.data_dir = args.data_dir.clone().or_else(nsh_engine::data_dir);
    options.trace = args.trace;
    options.fps = args.fps;
    options.cells = args.points_per_cell;
    let terminal_clipboard = (options.clipboard.is_none() && !args.headless)
        .then(|| std::sync::Arc::new(clipboard::TerminalClipboard::default()));
    if let Some(clipboard) = &terminal_clipboard {
        options.clipboard = Some(clipboard.clone());
    }
    if options.assets.is_none()
        && let Some(path) = &args.bundle
    {
        options.assets = Some(std::sync::Arc::new(assets::Directory(
            path.parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("assets"),
        )));
    }
    let _shutdown = shutdown::Guard::install()?;
    // The terminal answers its startup queries before the surface takes its colors.
    let session = if args.headless {
        None
    } else {
        let session = terminal::Session::enter(!args.no_mouse)?;
        options.capabilities = session.capabilities();
        Some(session)
    };
    let mut view = AppView::new(options);
    view.set_dev_log_path(log_file);
    let is_dev = args.bundle.is_none();
    let failure = Rc::new(RefCell::new(None));
    let reported = failure.clone();
    view.on_app_error(move |error| {
        *reported.borrow_mut() = Some(error.to_string());
    });
    if args.headless {
        let (columns, rows) = match args.window_size {
            Some(size) => {
                let columns = (size.width() / args.points_per_cell.width()).ceil();
                let rows = (size.height() / args.points_per_cell.height()).ceil();
                if columns > f32::from(u16::MAX) || rows > f32::from(u16::MAX) {
                    return Err(io::Error::other("window size exceeds the terminal grid"));
                }
                (columns as u16, rows as u16)
            }
            None => (100, 40),
        };
        let mut terminal =
            Terminal::new(view.measure_backend(TestBackend::new(columns, rows))).unwrap();
        run(&mut terminal, &mut view, &args, |timeout| {
            std::thread::sleep(timeout);
            Ok(if shutdown::requested() {
                RunEvent::Exit
            } else {
                RunEvent::Idle
            })
        })?;
    } else if let Some(session) = session {
        let cursor = Rc::new(std::cell::Cell::new(
            nsh_platform_tui::CursorStyle::default(),
        ));
        let changed = cursor.clone();
        view.on_cursor_style_changed(move |style| changed.set(style));
        let mut shown = nsh_platform_tui::CursorStyle::default();
        let (mut frames, writer) = terminal::Frames::new(terminal::Output, session.synchronized());
        let mut terminal = Terminal::new(view.measure_backend(CrosstermBackend::new(
            io::BufWriter::new(view.measure_writer(writer)),
        )))?;
        let result = run(&mut terminal, &mut view, &args, |timeout| {
            // The frame just drawn, whole, before any escape written between frames.
            frames.commit()?;
            if !session.is_active() {
                Err(io::Error::other("terminal session ended after a panic"))
            } else if shutdown::requested() || (!is_dev && failure.borrow().is_some()) {
                Ok(RunEvent::Exit)
            } else {
                if let Some(clipboard) = &terminal_clipboard {
                    clipboard.flush()?;
                }
                // Between frames, as the clipboard's escapes: never inside a frame's output.
                if cursor.get() != shown {
                    shown = cursor.get();
                    terminal::set_cursor_style(shown)?;
                }
                let event = terminal::poll(timeout)?;
                if let RunEvent::Input(nsh_platform_tui::Input::Focus(true)) = event {
                    session.reassert()?;
                }
                Ok(event)
            }
        });
        let result = result.and_then(|()| {
            if !shutdown::requested() {
                frames.commit()?;
            }
            if !shutdown::requested()
                && let Some(clipboard) = &terminal_clipboard
            {
                clipboard.flush()?;
            }
            Ok(())
        });
        let interrupted = shutdown::requested();
        // Ratatui and buffered writers can write during Drop. Only the session's bounded,
        // best-effort restoration may write once the run loop has ended.
        shutdown::request_exit();
        if !interrupted {
            result?;
        }
    }
    let error = if is_dev {
        None
    } else {
        failure.borrow_mut().take()
    };
    match error {
        Some(error) => Err(io::Error::other(error)),
        None => Ok(()),
    }
}

fn run<B: Backend>(
    terminal: &mut Terminal<B>,
    view: &mut AppView,
    args: &Args,
    poll: impl FnMut(std::time::Duration) -> Result<RunEvent, B::Error>,
) -> io::Result<()> {
    // Prime the area before loading so the first engine layout has the terminal's size.
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .map_err(|error| io::Error::other(error.to_string()))?;
    if let Some(path) = &args.bundle {
        view.load(Bundle::read(path)?)?;
    } else {
        view.connect_dev_server(
            args.dev_server
                .as_deref()
                .unwrap_or("ws://127.0.0.1:8790/ws"),
        )?;
    }
    run_app(terminal, view, poll).map_err(|error| io::Error::other(error.to_string()))
}
