//! What the tasks print, in the style of the `nsh` command line
//! (`crates/nsh-cli/src/ui.rs`, which xtask cannot depend on: it would
//! build the bundler before every `cargo run`): one `✓` line per step,
//! the tools' output captured and printed only when they fail. Verbose
//! (`-v`, `NSH_VERBOSE=1`) lets it through as it comes.

use std::{
    fmt::Display,
    io::{IsTerminal as _, Read as _, Write as _},
    process::{Command, Stdio},
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use anyhow::Context as _;

struct Term {
    tty: bool,
    color: bool,
    verbose: bool,
}

static TERM: OnceLock<Term> = OnceLock::new();

fn term() -> &'static Term {
    TERM.get_or_init(|| Term {
        tty: false,
        color: false,
        verbose: false,
    })
}

/// Sets up the output.
pub(crate) fn init(verbose: bool) {
    let tty = std::io::stderr().is_terminal();
    #[cfg(windows)]
    if tty {
        use windows_sys::Win32::System::Console::{
            ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode, GetStdHandle, STD_ERROR_HANDLE,
            SetConsoleMode,
        };
        // Colors and the step line's clearing are escape sequences, which
        // the console takes only when asked to.
        // SAFETY: plain console calls on this process's stderr handle;
        // `mode` is a local the call fills.
        unsafe {
            let err = GetStdHandle(STD_ERROR_HANDLE);
            let mut mode = 0;
            if GetConsoleMode(err, &mut mode) != 0 {
                SetConsoleMode(err, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
            }
        }
    }
    let no_color = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
    let _ = TERM.set(Term {
        tty,
        color: tty && !no_color,
        verbose,
    });
}

/// Whether everything is shown as it comes.
pub(crate) fn verbose() -> bool {
    term().verbose
}

fn paint(code: &str, text: impl Display) -> String {
    if term().color {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

/// A step's line is on screen ([`Step`]).
static PENDING: AtomicBool = AtomicBool::new(false);

fn line(text: &str) {
    let mut err = std::io::stderr().lock();
    if PENDING.swap(false, Ordering::Relaxed) {
        let _ = err.write_all(b"\r\x1b[2K");
    }
    let _ = writeln!(err, "{text}");
}

/// `✓ message`.
pub(crate) fn done(message: impl Display) {
    line(&format!("{} {message}", paint("32", "✓")));
}

/// `→ message`.
pub(crate) fn note(message: impl Display) {
    line(&format!("{} {message}", paint("36", "→")));
}

/// `warning message`.
pub(crate) fn warn(message: impl Display) {
    line(&format!("{} {message}", paint("33", "warning")));
}

/// Prints `error <message>` and the output of the tool that failed.
pub(crate) fn report(error: &anyhow::Error) {
    line(&format!("{} {error:#}", paint("31", "error")));
    if let Some(failure) = error.chain().find_map(|e| e.downcast_ref::<Failure>())
        && !failure.output.trim().is_empty()
    {
        line(failure.output.trim_end());
    }
}

/// A step: `label…` on a terminal while it runs, replaced by its `✓`
/// line.
pub(crate) struct Step {
    start: Instant,
}

impl Step {
    pub(crate) fn start(label: impl Display) -> Step {
        let term = term();
        if term.tty && !term.verbose {
            let mut err = std::io::stderr().lock();
            let _ = write!(err, "\r\x1b[2K{} {label}…", paint("36", "·"));
            let _ = err.flush();
            PENDING.store(true, Ordering::Relaxed);
        }
        Step {
            start: Instant::now(),
        }
    }

    /// Ends it with `✓ message (time)`.
    pub(crate) fn done(self, message: impl Display) {
        let secs = self.start.elapsed().as_secs_f64();
        let time = if secs < 60.0 {
            format!("{secs:.1}s")
        } else {
            format!("{}m {}s", secs as u64 / 60, secs as u64 % 60)
        };
        done(format!("{message} {}", paint("2", format!("({time})"))));
    }
}

impl Drop for Step {
    fn drop(&mut self) {
        if PENDING.swap(false, Ordering::Relaxed) {
            let _ = std::io::stderr().write_all(b"\r\x1b[2K");
        }
    }
}

/// A tool that failed, with its output ([`report`]).
#[derive(Debug)]
struct Failure {
    message: String,
    output: String,
}

impl Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Failure {}

/// Runs `cmd` with its output captured, failing with it if `cmd` fails
/// (verbose: the output goes through).
pub(crate) fn run(cmd: &mut Command) -> anyhow::Result<()> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    exec(cmd, format!("{program} failed"))
}

/// [`run`], failing with `message`.
fn exec(cmd: &mut Command, message: String) -> anyhow::Result<()> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let failed = |output: String| -> anyhow::Error { Failure { message, output }.into() };
    if verbose() {
        let status = cmd.status().with_context(|| format!("run {program}"))?;
        return if status.success() {
            Ok(())
        } else {
            Err(failed(String::new()))
        };
    }
    let (reader, writer) = std::io::pipe()?;
    cmd.stdin(Stdio::null())
        .stdout(writer.try_clone()?)
        .stderr(writer);
    let child = cmd.spawn();
    // The command's own copies of the write end would keep the pipe open.
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = child.with_context(|| format!("run {program}"))?;
    // The tools' output is not always UTF-8 (javac's notes follow the
    // machine's locale): take it as it comes rather than fail the build
    // over it.
    let mut output_bytes = Vec::new();
    let mut reader = reader;
    reader
        .read_to_end(&mut output_bytes)
        .with_context(|| format!("read {program}"))?;
    let output = String::from_utf8_lossy(&output_bytes).into_owned();
    if child.wait()?.success() {
        Ok(())
    } else {
        Err(failed(output))
    }
}

/// Runs the cargo build `cmd` as the step "building <what>".
pub(crate) fn cargo(cmd: &mut Command, what: &str) -> anyhow::Result<()> {
    let step = Step::start(format!("building {what}"));
    if !verbose() {
        let color = if term().color { "always" } else { "never" };
        cmd.env("CARGO_TERM_COLOR", color);
    }
    exec(cmd, format!("building {what} failed"))?;
    step.done(format!("built {what}"));
    Ok(())
}
