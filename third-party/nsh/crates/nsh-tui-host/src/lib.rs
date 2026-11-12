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

pub use shutdown::request_exit;
pub use terminal::convert;

/// The host's options, as its command line gives them. An embedding program parses its own
/// arguments (`Args::try_parse_from`) or starts from [`Args::default`].
#[derive(Parser)]
#[non_exhaustive]
#[command(
    about = "Run Native Shell in the terminal (C-h e opens logs; Ctrl+C copies a selection, else exits)"
)]
pub struct Args {
    /// The prebuilt bundle to run.
    #[arg(long, conflicts_with = "dev_server")]
    pub bundle: Option<PathBuf>,
    /// The development server to load the app from, when no bundle is given.
    #[arg(long)]
    pub dev_server: Option<String>,
    /// The size of one terminal cell in points.
    #[arg(long, default_value = "8x16")]
    pub points_per_cell: CellSize,
    /// Where the host writes its log; a file in the temporary directory when absent.
    #[arg(long)]
    pub log_file: Option<PathBuf>,
    /// The app's data directory; the engine's default when absent.
    #[arg(long)]
    pub data_dir: Option<PathBuf>,
    /// Log at trace level.
    #[arg(long)]
    pub trace: bool,
    /// Show frame timings and terminal output (C-h p toggles).
    #[arg(long)]
    pub fps: bool,
    /// Leave the mouse to the terminal (its own text selection) instead of capturing
    /// clicks, hover, dragging and the wheel.
    #[arg(long)]
    pub no_mouse: bool,

    /// Render to an in-memory terminal (used by nsh test).
    #[arg(long, requires = "dev_server")]
    pub headless: bool,
    /// Initial in-memory viewport in points, rounded up to whole Cells.
    #[arg(long, requires = "headless")]
    pub window_size: Option<CellSize>,
}

impl Default for Args {
    /// The options of a command line that gives none.
    fn default() -> Self {
        Self::parse_from(["nsh-tui-host"])
    }
}

/// Parses host arguments and runs the selected bundle. The binary owns logging and diagnostics.
pub fn main() -> io::Result<()> {
    main_with_options(AppOptions::default())
}

/// Runs the host with an app's registered UI sets and optional Rust root.
pub fn main_with_options(options: AppOptions) -> io::Result<()> {
    main_with_args(options, Args::parse())
}

/// Runs the host with an app's registered UI sets and options given by the embedding program
/// rather than read from its command line, as when the host runs inside another program.
///
/// For the run, the host takes the process's SIGINT, SIGTERM and SIGHUP (on Windows, Ctrl+C
/// and Ctrl+Break through `SetConsoleCtrlHandler`): each asks it to exit, as [`request_exit`]
/// does, and the program's own handlers do not see them. The host puts back the handlers it
/// found when the run ends.
pub fn main_with_args(mut options: AppOptions, args: Args) -> io::Result<()> {
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
    // A request made before the run ends it here: once a request is set, the terminal refuses
    // writes, so entering the session would fail.
    if shutdown::requested() {
        return Ok(());
    }
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
