//! What the command line prints: one line per step, and the details only
//! when something fails (`docs/dev/tooling.md`, "Output").
//!
//! - `✓` a step that finished, `→` where to find something, `•` what a
//!   device did, `warn` / `error` problems; plain lines are the app's own
//!   output (its `console.*`).
//! - While a step runs ([`Step`]), a spinner line shows it, replaced by the
//!   step's `✓` line. Only on a terminal: otherwise just the result lines.
//! - Colors on terminals, unless `NO_COLOR` is set.
//! - The output of the tools the CLI runs (cargo, the hosts) is captured
//!   ([`cargo`], [`capture`]) and printed under the `error` line only when
//!   they fail ([`failure`], [`report`]).
//! - Verbose (`-v`, `NSH_VERBOSE=1`): no spinner, and everything as it
//!   comes: log lines with their levels and targets (`logger.rs`), the
//!   tools' and hosts' own output.
//!
//! Everything goes to stderr: stdout is the commands' results (`nsh test --trace`'s
//! mount items, the signing commands' lines).

use std::{
    collections::VecDeque,
    fmt::Display,
    io::{BufRead as _, BufReader, IsTerminal as _, Write as _},
    path::Path,
    process::{Command, ExitStatus, Stdio},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, AtomicI32, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::Context as _;

/// How the terminal is used, decided once ([`init`]).
struct Term {
    /// stderr is a terminal: spinners, wrapping.
    tty: bool,
    color: bool,
    verbose: bool,
}

static TERM: OnceLock<Term> = OnceLock::new();

fn term() -> &'static Term {
    TERM.get_or_init(|| Term::detect(false))
}

impl Term {
    fn detect(verbose: bool) -> Term {
        let tty = std::io::stderr().is_terminal();
        let no_color = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
        Term {
            tty,
            color: tty && !no_color,
            verbose,
        }
    }
}

/// Sets up the output: verbose or not, and what stderr is.
pub(crate) fn init(verbose: bool) {
    let _ = TERM.set(Term::detect(verbose));
    #[cfg(windows)]
    win::init();
    #[cfg(unix)]
    // SAFETY: a zeroed `sigaction` is a valid value (no flags, an empty
    // mask) before the fields are set; the handler only uses
    // async-signal-safe calls (`write`, `signal`, `raise`) and atomics.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_signal as *const () as libc::sighandler_t;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
}

/// Whether everything is shown as it comes.
pub(crate) fn verbose() -> bool {
    term().verbose
}

/// Whether output is colored.
pub(crate) fn color() -> bool {
    term().color
}

/// Mirrors [`Out::drawn`] for the signal handler, which cannot lock.
static SPINNER_DRAWN: AtomicBool = AtomicBool::new(false);

/// Live [`Stoppable`]s.
static STOPPABLE: AtomicUsize = AtomicUsize::new(0);
/// The signal that asked a [`Stoppable`] command to stop (0: none).
static STOP_SIGNAL: AtomicI32 = AtomicI32::new(0);

/// Until dropped, Ctrl-C (SIGINT) and SIGTERM ask the command to stop
/// ([`stop_requested`]) instead of ending the process, so that it undoes
/// what it set up outside it on its way out (`nsh run`'s `adb reverse`);
/// a second one ends the process. [`crate::main`] then ends it as the
/// signal would have.
pub(crate) struct Stoppable(());

impl Stoppable {
    pub(crate) fn new() -> Stoppable {
        STOPPABLE.fetch_add(1, Ordering::SeqCst);
        Stoppable(())
    }
}

impl Drop for Stoppable {
    fn drop(&mut self) {
        STOPPABLE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Whether a signal asked the command to stop ([`Stoppable`]).
pub(crate) fn stop_requested() -> bool {
    STOP_SIGNAL.load(Ordering::SeqCst) != 0 || crate::dev_port::stop_requested()
}

/// After a requested stop: ends the process as the signal would have
/// (the shell sees an interrupted command).
pub(crate) fn exit_if_stopped() {
    let signal = STOP_SIGNAL.load(Ordering::SeqCst);
    if signal != 0 {
        exit_by_signal(signal);
    }
}

/// Ends the process with `signal`'s default action.
fn exit_by_signal(signal: libc::c_int) {
    // SAFETY: back to the default action, then raise it.
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
        libc::raise(signal);
    }
}

/// Ctrl-C (or a stop): asks a [`Stoppable`] command to stop, else (or the
/// second time) clears a spinner's line and ends the process as the signal
/// would have.
#[cfg(unix)]
extern "C" fn on_signal(signal: libc::c_int) {
    if STOPPABLE.load(Ordering::SeqCst) > 0
        && STOP_SIGNAL
            .compare_exchange(0, signal, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        return;
    }
    if SPINNER_DRAWN.load(Ordering::SeqCst) {
        let clear = b"\r\x1b[2K";
        // SAFETY: async-signal-safe calls with a valid buffer.
        unsafe { libc::write(libc::STDERR_FILENO, clear.as_ptr().cast(), clear.len()) };
    }
    // SAFETY: as above: back to the default action, then raise it again.
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
        libc::raise(signal);
    }
}

/// The console's side of [`init`] and [`columns`] on Windows.
#[cfg(windows)]
mod win {
    use std::sync::atomic::Ordering;

    use windows_sys::Win32::{
        Foundation::{FALSE, TRUE},
        System::Console::{
            CONSOLE_SCREEN_BUFFER_INFO, CTRL_BREAK_EVENT, CTRL_C_EVENT,
            ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode, GetConsoleScreenBufferInfo,
            GetStdHandle, STD_ERROR_HANDLE, SetConsoleCtrlHandler, SetConsoleMode,
        },
    };

    use super::{SPINNER_DRAWN, STOP_SIGNAL, STOPPABLE};

    /// Turns on escape sequences (colors, the spinner's line clearing) and
    /// takes Ctrl-C as `on_signal` does on Unix.
    pub(super) fn init() {
        // SAFETY: plain console calls on this process's stderr handle;
        // `mode` is a local the call fills.
        unsafe {
            let err = GetStdHandle(STD_ERROR_HANDLE);
            let mut mode = 0;
            if GetConsoleMode(err, &mut mode) != 0 {
                SetConsoleMode(err, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
            }
            SetConsoleCtrlHandler(Some(on_ctrl), TRUE);
        }
    }

    /// Runs on a thread of its own: a [`super::Stoppable`] command is asked
    /// to stop the first time; otherwise the spinner's line is cleared and
    /// the default handler ends the process.
    unsafe extern "system" fn on_ctrl(event: u32) -> i32 {
        if event != CTRL_C_EVENT && event != CTRL_BREAK_EVENT {
            return FALSE;
        }
        if STOPPABLE.load(Ordering::SeqCst) > 0
            && STOP_SIGNAL
                .compare_exchange(0, libc::SIGINT, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            return TRUE;
        }
        if SPINNER_DRAWN.load(Ordering::SeqCst) {
            use std::io::Write as _;
            let _ = std::io::stderr().write_all(b"\r\x1b[2K");
        }
        FALSE
    }

    /// The console window's width in columns.
    pub(super) fn columns() -> Option<usize> {
        // SAFETY: a zeroed `CONSOLE_SCREEN_BUFFER_INFO` is valid plain data,
        // filled by the call.
        unsafe {
            let err = GetStdHandle(STD_ERROR_HANDLE);
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            (GetConsoleScreenBufferInfo(err, &mut info) != 0)
                .then(|| (info.srWindow.Right - info.srWindow.Left + 1).max(0) as usize)
        }
    }
}

// ---------------------------------------------------------------------------
// Styles

fn paint(code: &str, text: impl Display) -> String {
    if color() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

/// Secondary text: timings, sizes, hints.
pub(crate) fn dim(text: impl Display) -> String {
    paint("2", text)
}

pub(crate) fn green(text: impl Display) -> String {
    paint("32", text)
}

pub(crate) fn cyan(text: impl Display) -> String {
    paint("36", text)
}

pub(crate) fn yellow(text: impl Display) -> String {
    paint("33", text)
}

pub(crate) fn red(text: impl Display) -> String {
    paint("31", text)
}

/// `url`, clickable in terminals that support hyperlinks (OSC 8), cyan;
/// the bare URL where colors are off (terminals linkify it themselves).
pub(crate) fn link(url: &str) -> String {
    if color() {
        format!("\x1b]8;;{url}\x1b\\{}\x1b]8;;\x1b\\", cyan(url))
    } else {
        url.to_owned()
    }
}

/// `text` without its ANSI escape sequences.
pub(crate) fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: ESC [ parameters final-byte (@ to ~).
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC (hyperlinks, [`link`]): ESC ] ... ending with BEL or ESC \.
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The width `text` takes on a terminal (one column per character).
fn width(text: &str) -> usize {
    strip_ansi(text).chars().count()
}

/// `path` relative to the current directory when it is inside it.
pub(crate) fn path(path: &Path) -> String {
    let full = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let cwd = std::env::current_dir().and_then(dunce::canonicalize);
    match cwd.as_deref().map(|cwd| full.strip_prefix(cwd)) {
        Ok(Ok(rest)) if rest.as_os_str().is_empty() => ".".to_owned(),
        Ok(Ok(rest)) => rest.display().to_string(),
        _ => path.display().to_string(),
    }
}

/// A size: `500 B`, `3.2 KB`, `1.4 MB`.
pub(crate) fn bytes(n: usize) -> String {
    const K: f64 = 1024.0;
    let n_f = n as f64;
    if n < 1024 {
        format!("{n} B")
    } else if n_f < K * K {
        format!("{:.1} KB", n_f / K)
    } else {
        format!("{:.1} MB", n_f / (K * K))
    }
}

/// A duration: `21ms`, `5.0s`, `1m 3s`.
pub(crate) fn duration(d: Duration) -> String {
    let ms = d.as_millis();
    if ms < 1000 {
        format!("{ms}ms")
    } else if ms < 60_000 {
        format!("{:.1}s", d.as_secs_f64())
    } else {
        format!("{}m {}s", ms / 60_000, ms % 60_000 / 1000)
    }
}

// ---------------------------------------------------------------------------
// Lines

/// What is printed, and the spinner drawn below it.
struct Out {
    terminal_sessions: usize,
    deferred: VecDeque<String>,
    /// Running steps; the last one is drawn.
    spinners: Vec<Spinner>,
    /// The spinner line is on screen.
    drawn: bool,
    frame: usize,
}

struct Spinner {
    id: u64,
    label: String,
    status: String,
    start: Instant,
}

static OUT: Mutex<Out> = Mutex::new(Out {
    spinners: Vec::new(),
    drawn: false,
    frame: 0,
    terminal_sessions: 0,
    deferred: VecDeque::new(),
});

const FRAMES: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

fn out() -> std::sync::MutexGuard<'static, Out> {
    OUT.lock().unwrap_or_else(|e| e.into_inner())
}

impl Out {
    fn clear(&mut self, err: &mut impl std::io::Write) {
        if self.drawn {
            let _ = err.write_all(b"\r\x1b[2K");
            self.drawn = false;
            SPINNER_DRAWN.store(false, Ordering::SeqCst);
        }
    }

    fn draw(&mut self, err: &mut impl std::io::Write) {
        if self.terminal_sessions > 0 {
            return;
        }
        let Some(spinner) = self.spinners.last() else {
            return self.clear(err);
        };
        let columns = columns().unwrap_or(80).saturating_sub(1);
        let mut rest = String::new();
        let elapsed = spinner.start.elapsed();
        if elapsed >= Duration::from_secs(1) {
            rest.push_str(&format!(" {}s", elapsed.as_secs()));
        }
        if !spinner.status.is_empty() {
            rest.push_str(" · ");
            rest.push_str(&spinner.status);
        }
        // "⠋ label…" then the dim rest, cut to the terminal's width (a line
        // that wraps could not be cleared).
        let label: String = format!("{}…", spinner.label)
            .chars()
            .take(columns.saturating_sub(2))
            .collect();
        let room = columns.saturating_sub(2 + label.chars().count());
        let rest: String = rest.chars().take(room).collect();
        let frame = FRAMES[self.frame % FRAMES.len()];
        let rest = if rest.is_empty() { rest } else { dim(rest) };
        let _ = write!(err, "\r\x1b[2K{} {label}{rest}", cyan(frame));
        let _ = err.flush();
        self.drawn = true;
        SPINNER_DRAWN.store(true, Ordering::SeqCst);
    }
}

/// Prints `text` (whole lines) above the spinner.
fn print(text: &str) {
    let mut out = out();
    if out.terminal_sessions > 0 {
        // Keep diagnostics for after the child restores the screen, with
        // bounded memory even when the app logs every animation frame.
        out.deferred.push_back(text.chars().take(4096).collect());
        if out.deferred.len() > 128 {
            out.deferred.pop_front();
        }
        return;
    }
    let mut err = std::io::stderr().lock();
    out.clear(&mut err);
    let _ = err.write_all(text.as_bytes());
    if !text.ends_with('\n') {
        let _ = err.write_all(b"\n");
    }
    out.draw(&mut err);
}

/// Gives an interactive child exclusive access to the terminal. Parent
/// progress and device logs are buffered until the child restores it.
pub(crate) struct TerminalSession(());

impl TerminalSession {
    pub(crate) fn new() -> Self {
        let mut out = out();
        out.clear(&mut std::io::stderr().lock());
        out.terminal_sessions += 1;
        Self(())
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let mut out = out();
        out.terminal_sessions -= 1;
        if out.terminal_sessions == 0 {
            let mut err = std::io::stderr().lock();
            for line in out.deferred.drain(..) {
                let _ = err.write_all(line.as_bytes());
                if !line.ends_with('\n') {
                    let _ = err.write_all(b"\n");
                }
            }
            out.draw(&mut err);
        }
    }
}

/// The terminal's width, when stderr is one.
fn columns() -> Option<usize> {
    if !term().tty {
        return None;
    }
    #[cfg(unix)]
    // SAFETY: TIOCGWINSZ fills the zeroed winsize it is given.
    let size = unsafe {
        let mut size: libc::winsize = std::mem::zeroed();
        (libc::ioctl(libc::STDERR_FILENO, libc::TIOCGWINSZ, &mut size) == 0)
            .then_some(usize::from(size.ws_col))
    };
    #[cfg(windows)]
    let size = win::columns();
    size.filter(|&c| c > 20)
}

/// `tag message`, the message wrapped to the terminal with a hanging
/// indent under its first word (its own lines too).
fn tagged(tag: &str, message: &str) -> String {
    let columns = columns().map(|c| c.saturating_sub(width(tag) + 1).max(20));
    wrap(tag, message, columns)
}

/// [`tagged`] for lines of `room` columns after the tag (`None`: no
/// wrapping).
fn wrap(tag: &str, message: &str, room: Option<usize>) -> String {
    let indent = width(tag) + 1;
    let mut text = String::new();
    for (i, line) in message.lines().enumerate() {
        let mut col = 0;
        if i > 0 {
            text.push('\n');
        }
        text.push_str(&if i == 0 {
            format!("{tag} ")
        } else {
            " ".repeat(indent)
        });
        for (j, word) in line.split(' ').enumerate() {
            let w = width(word);
            if j > 0 {
                // A word longer than a line (a path) stays: the terminal
                // wraps it.
                if room.is_some_and(|room| col + 1 + w > room && w <= room) {
                    text.push('\n');
                    text.push_str(&" ".repeat(indent));
                    col = 0;
                } else {
                    text.push(' ');
                    col += 1;
                }
            }
            text.push_str(word);
            col += w;
        }
    }
    text
}

/// `✓ message`: a step finished.
pub(crate) fn done(message: impl Display) {
    print(&format!("{} {message}", green("✓")));
}

/// `→ message`: where to find something.
pub(crate) fn note(message: impl Display) {
    print(&format!("{} {message}", cyan("→")));
}

/// `  message`: more about the line above.
pub(crate) fn detail(message: impl Display) {
    print(&format!("  {message}"));
}

/// `• message`: what a device did.
pub(crate) fn event(message: impl Display) {
    print(&format!("{} {message}", cyan("•")));
}

/// `warn message`.
pub(crate) fn warn(message: impl Display) {
    print(&tagged(&yellow("warn"), &message.to_string()));
}

/// `error message`.
pub(crate) fn error(message: impl Display) {
    print(&tagged(&red("error"), &message.to_string()));
}

/// A line as it is: the app's own output, or a tool's.
pub(crate) fn plain(message: impl Display) {
    print(&message.to_string());
}

/// A line only verbose runs show.
pub(crate) fn debug(message: impl Display) {
    if verbose() {
        print(&dim(message));
    }
}

/// Whether the command line may ask the user: stdin and stdout are a
/// terminal (not a pipe, a CI job or an editor's task).
pub(crate) fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// `? question`, then the `options` (a name and what it is), numbered:
/// the index of the one the user picks by number or name. Enter (or the
/// end of input) picks the first; anything else asks again.
pub(crate) fn choose(question: &str, options: &[(&str, &str)]) -> anyhow::Result<usize> {
    let name_width = options
        .iter()
        .map(|(name, _)| width(name))
        .max()
        .unwrap_or(0);
    print(&format!("{} {question}", cyan("?")));
    for (i, (name, what)) in options.iter().enumerate() {
        let pad = " ".repeat(name_width - width(name));
        print(&format!(
            "  {} {name}{pad}  {}",
            dim(format!("{}.", i + 1)),
            dim(what)
        ));
    }
    let default = options.first().map_or("", |(name, _)| name);
    let stdin = std::io::stdin();
    loop {
        eprint!(
            "{} {}",
            cyan("?"),
            dim(format!("1-{}, or Enter for {default}: ", options.len()))
        );
        let _ = std::io::stderr().flush();
        let mut line = String::new();
        if stdin
            .lock()
            .read_line(&mut line)
            .context("read the answer")?
            == 0
        {
            eprintln!();
            return Ok(0);
        }
        let answer = line.trim();
        if answer.is_empty() {
            return Ok(0);
        }
        let picked = answer
            .parse::<usize>()
            .ok()
            .and_then(|n| n.checked_sub(1))
            .filter(|&i| i < options.len())
            .or_else(|| {
                options
                    .iter()
                    .position(|(name, _)| name.eq_ignore_ascii_case(answer))
            });
        match picked {
            Some(i) => return Ok(i),
            None => warn(format!("{answer:?} is none of them")),
        }
    }
}

// ---------------------------------------------------------------------------
// Steps

/// A step that takes a while: a spinner line while it runs (on a terminal),
/// replaced by its `✓` line ([`Step::done`]) or by nothing
/// ([`Step::finish`]; also when it is dropped, as on errors).
pub(crate) struct Step {
    id: u64,
    start: Instant,
}

impl Step {
    /// Starts the step, `label` saying what it does ("building …").
    pub(crate) fn start(label: impl Into<String>) -> Step {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let start = Instant::now();
        if term().tty && !verbose() {
            spin();
            let mut out = out();
            out.spinners.push(Spinner {
                id,
                label: label.into(),
                status: String::new(),
                start,
            });
            out.draw(&mut std::io::stderr().lock());
        }
        Step { id, start }
    }

    /// What the step is at (shown after its label).
    pub(crate) fn status(&self, status: &str) {
        let mut out = out();
        if let Some(spinner) = out.spinners.iter_mut().find(|s| s.id == self.id) {
            spinner.status = status.to_owned();
        }
    }

    /// How long it has run.
    pub(crate) fn elapsed(&self) -> Duration {
        self.start.elapsed()
    }

    /// Ends it with `✓ message (time)`.
    pub(crate) fn done(self, message: impl Display) {
        self.done_with(message, None);
    }

    /// Ends it with `✓ message (time, note)`.
    pub(crate) fn done_with(self, message: impl Display, note: Option<&str>) {
        let time = duration(self.elapsed());
        let paren = match note {
            Some(note) => format!("({time}, {note})"),
            None => format!("({time})"),
        };
        drop(self);
        done(format!("{message} {}", dim(paren)));
    }

    /// Ends it without a line.
    pub(crate) fn finish(self) {}
}

impl Drop for Step {
    fn drop(&mut self) {
        let mut out = out();
        let before = out.spinners.len();
        out.spinners.retain(|s| s.id != self.id);
        if out.spinners.len() != before {
            out.draw(&mut std::io::stderr().lock());
        }
    }
}

/// Starts the thread that animates spinners (once).
fn spin() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("nsh-spinner".into())
            .spawn(|| {
                loop {
                    std::thread::sleep(Duration::from_millis(80));
                    let mut out = out();
                    if !out.spinners.is_empty() {
                        out.frame += 1;
                        out.draw(&mut std::io::stderr().lock());
                    }
                }
            });
    });
}

// ---------------------------------------------------------------------------
// Tools

/// A failure whose details (a tool's output) are printed below its
/// message ([`report`]).
#[derive(Debug)]
pub(crate) struct Failure {
    message: String,
    details: String,
}

/// A [`Failure`] saying `message`, with `details` below it.
pub(crate) fn failure(message: impl Into<String>, details: impl Into<String>) -> anyhow::Error {
    Failure {
        message: message.into(),
        details: details.into(),
    }
    .into()
}

impl Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Failure {}

/// `error` as one message: its chain, then the details of the
/// [`Failure`] in it (a compiler's diagnostics), for reports that carry a
/// message instead of printing it (a test's failure).
pub(crate) fn with_details(error: &anyhow::Error) -> String {
    let mut message = format!("{error:#}");
    if let Some(failure) = error.chain().find_map(|e| e.downcast_ref::<Failure>())
        && !failure.details.trim().is_empty()
    {
        message.push('\n');
        message.push_str(failure.details.trim_end());
    }
    message
}

/// Prints `error`: `error <message>`, and the details of the
/// [`Failure`] in it.
pub(crate) fn report(error: &anyhow::Error) {
    self::error(format!("{error:#}"));
    if let Some(failure) = error.chain().find_map(|e| e.downcast_ref::<Failure>())
        && !failure.details.trim().is_empty()
    {
        plain(failure.details.trim_end());
    }
}

/// Runs `cmd` with its output (stdout and stderr, in order) captured, each
/// line passed to `on_line` too; returns its status and the output.
/// Verbose runs let the output through instead (and return none).
pub(crate) fn capture(
    cmd: &mut Command,
    on_line: impl FnMut(&str),
) -> std::io::Result<(ExitStatus, String)> {
    if verbose() {
        return Ok((cmd.status()?, String::new()));
    }
    capture_all(cmd, on_line)
}

/// [`capture`] for output the caller reads (`cargo test`'s results):
/// verbose runs get it too, and show each line as it comes.
pub(crate) fn capture_all(
    cmd: &mut Command,
    mut on_line: impl FnMut(&str),
) -> std::io::Result<(ExitStatus, String)> {
    let (reader, writer) = std::io::pipe()?;
    cmd.stdin(Stdio::null())
        .stdout(writer.try_clone()?)
        .stderr(writer);
    let child = cmd.spawn();
    // The command keeps its copies of the pipe's write end: without
    // dropping them the read below never ends.
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = child?;
    let mut output = String::new();
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line)? > 0 {
        let text = String::from_utf8_lossy(&line);
        let text_line = text.trim_end_matches(['\n', '\r']);
        if verbose() {
            plain(text_line);
        }
        on_line(text_line);
        output.push_str(&text);
        line.clear();
    }
    Ok((child.wait()?, output))
}

/// Runs the cargo build `cmd` as step `building <what>`: the spinner
/// shows the crate it compiles, the output is shown only if it fails, and
/// warnings are counted (`-v` shows them).
pub(crate) fn cargo(cmd: &mut Command, what: &str) -> anyhow::Result<()> {
    cargo_as(cmd, ["building", "built"], what)
}

/// [`cargo`] for another cargo command (`cargo check`): `doing` names the
/// step while it runs and once it ends (`["checking", "checked"]`).
pub(crate) fn cargo_as(cmd: &mut Command, doing: [&str; 2], what: &str) -> anyhow::Result<()> {
    let [doing, done] = doing;
    let step = Step::start(format!("{doing} {what}"));
    if !verbose() {
        cmd.env("CARGO_TERM_COLOR", if color() { "always" } else { "never" });
    }
    let mut warnings = 0;
    let (status, output) = capture(cmd, |line| {
        let line = strip_ansi(line);
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("Compiling ") {
            step.status(rest.split(' ').next().unwrap_or(rest));
        }
        warnings += generated_warnings(line);
    })
    .context("run cargo")?;
    if !status.success() {
        return Err(failure(format!("{doing} {what} failed"), output));
    }
    let note = match warnings {
        0 => None,
        1 => Some("1 warning: -v shows it".to_owned()),
        n => Some(format!("{n} warnings: -v shows them")),
    };
    step.done_with(format!("{done} {what}"), note.as_deref());
    Ok(())
}

/// The count in cargo's "warning: `crate` (lib) generated 2 warnings".
fn generated_warnings(line: &str) -> usize {
    let Some(rest) = line.strip_prefix("warning: ") else {
        return 0;
    };
    let Some((_, count)) = rest.split_once(" generated ") else {
        return 0;
    };
    count
        .split(' ')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// The last lines a long-running process printed, kept to show if it
/// fails ([`quiet`]).
#[derive(Clone, Default)]
pub(crate) struct Tail(std::sync::Arc<Mutex<std::collections::VecDeque<String>>>);

impl Tail {
    /// The kept lines.
    pub(crate) fn text(&self) -> String {
        let lines = self.0.lock().unwrap_or_else(|e| e.into_inner());
        lines
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Spawns `cmd`, a process that runs alongside the CLI (a host): its own
/// output is kept, not shown ([`Tail`]); verbose runs show it.
pub(crate) fn quiet(cmd: &mut Command) -> std::io::Result<(std::process::Child, Tail)> {
    const KEEP: usize = 200;
    let tail = Tail::default();
    if verbose() {
        return Ok((cmd.spawn()?, tail));
    }
    let (reader, writer) = std::io::pipe()?;
    cmd.stdout(writer.try_clone()?).stderr(writer);
    let child = cmd.spawn();
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let child = child?;
    let lines = tail.clone();
    std::thread::Builder::new()
        .name("nsh-host-output".into())
        .spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                let mut lines = lines.0.lock().unwrap_or_else(|e| e.into_inner());
                if lines.len() == KEEP {
                    lines.pop_front();
                }
                lines.push_back(line);
            }
        })?;
    Ok((child, tail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_failures_carry_the_compilers_diagnostics() {
        let error = failure("building App.tsx failed", "  x `nsh` has no export `If`\n");
        assert_eq!(
            with_details(&error),
            "building App.tsx failed\n  x `nsh` has no export `If`"
        );
        assert_eq!(with_details(&anyhow::anyhow!("no entry")), "no entry");
    }

    #[test]
    fn links_and_colors_strip_to_their_text() {
        let url = "http://127.0.0.1:8790/";
        let linked = format!("\x1b]8;;{url}\x1b\\\x1b[36m{url}\x1b[0m\x1b]8;;\x1b\\ next");
        assert_eq!(strip_ansi(&linked), format!("{url} next"));
        assert_eq!(strip_ansi("\x1b]8;;x\x07y\x1b]8;;\x07"), "y");
    }

    #[test]
    fn cargo_warning_summaries_are_counted() {
        for (line, count) in [
            ("warning: `app` (lib) generated 2 warnings", 2),
            ("warning: `app` (lib) generated 1 warning", 1),
            (
                "warning: `app` (lib) generated 3 warnings (run `cargo fix --lib -p app` to apply 1 suggestion)",
                3,
            ),
            ("warning: unused variable: `x`", 0),
            ("   Compiling app v0.1.0", 0),
        ] {
            assert_eq!(generated_warnings(line), count, "{line}");
        }
    }

    #[test]
    fn problems_wrap_under_their_first_word() {
        assert_eq!(
            wrap(
                "warn",
                "iOS Simulator: image failed: An SSL error has occurred",
                Some(20)
            ),
            "warn iOS Simulator: image\n     failed: An SSL error\n     has occurred"
        );
        // Their own lines too; a word longer than a line stays.
        assert_eq!(
            wrap(
                "error",
                "building /a/very/long/path/App.tsx failed\n  at x",
                Some(20)
            ),
            "error building /a/very/long/path/App.tsx\n      failed\n        at x"
        );
        assert_eq!(wrap("warn", "a b", None), "warn a b");
    }

    #[test]
    fn escapes_are_stripped() {
        assert_eq!(
            strip_ansi("\x1b[1m\x1b[32m   Compiling\x1b[0m taffy"),
            "   Compiling taffy"
        );
        assert_eq!(width("\x1b[33mwarn\x1b[0m"), 4);
    }

    #[test]
    fn sizes_and_times_read_well() {
        assert_eq!(bytes(500), "500 B");
        assert_eq!(bytes(3255), "3.2 KB");
        assert_eq!(bytes(3 << 20), "3.0 MB");
        assert_eq!(duration(Duration::from_millis(21)), "21ms");
        assert_eq!(duration(Duration::from_millis(12_640)), "12.6s");
        assert_eq!(duration(Duration::from_secs(63)), "1m 3s");
    }
}
