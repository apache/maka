//! The unified log (`os_log`) as the `log` facade's logger, for the release
//! runners (`nsh-macos-app`, `nsh-ios-app`) and the iOS SDK: an app opened
//! from Finder, the Dock or the Home screen has its stderr on `/dev/null`, so
//! its lines go where Console, `log stream` and Xcode's console read them.
//!
//! - The subsystem is the main bundle's identifier: the app's id (the host
//!   app's in the SDK), else the executable's name (a runner `nsh run` runs
//!   in place). The category is the record's target (`js` for `console.*`).
//!   Each category's log object is made on its first line and kept, as the
//!   log keeps it for the process anyway.
//! - Errors are `OS_LOG_TYPE_ERROR`; warnings and info `OS_LOG_TYPE_DEFAULT`,
//!   which the log stores and Console shows as they come (info's own type
//!   stays in memory and out of Console's view by default), a warning's text
//!   after `WARN`, which its type does not say; debug and trace
//!   `OS_LOG_TYPE_DEBUG`. The text is the app's own, logged `%{public}`: the
//!   log shows it as it is. The log stores about 1 KB of an entry, so a
//!   longer message takes several entries, split between its lines where it
//!   can be; a NUL in it is written `\0`.
//! - What is logged is the runners' rule: warnings, errors and the app's `js`
//!   lines, everything from info up in development.
//! - Lines also go to stderr wherever it goes but `/dev/null`: always when
//!   run by `nsh run`, and otherwise to a terminal, a file or a pipe
//!   (`2> app.log`, `open --stderr`, launchd's `StandardErrorPath`) unless a
//!   debugger's console shows the log already: Xcode streams it into its
//!   console (Xcode 15 on, which sets `IDE_DISABLED_OS_ACTIVITY_DT_MODE`) or
//!   has it copied to stderr (`OS_ACTIVITY_DT_MODE`). A scheme that turns the
//!   process's log off to quiet the system's lines (`OS_ACTIVITY_MODE=disable`)
//!   gets them on stderr under Xcode too.
//!
//! `os_log_with_type` is a C macro, so `os_log.c` wraps it in a function,
//! compiled by the crate's `build.rs`.

use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char, c_void},
    fmt::Write as _,
    io::Write as _,
    mem::MaybeUninit,
    os::fd::RawFd,
    ptr::NonNull,
    sync::{Mutex, OnceLock, PoisonError},
};

use log::{Level, LevelFilter, Log, Metadata, Record};
use objc2_foundation::NSBundle;

unsafe extern "C" {
    /// `<os/log.h>`: the log object of a subsystem and a category, made on
    /// the first call; later calls return the same one, never deallocated.
    fn os_log_create(subsystem: *const c_char, category: *const c_char) -> *mut c_void;
    /// `os_log.c`: `os_log_with_type(log, kind, "%{public}s", message)`.
    fn platform_apple_os_log(log: *mut c_void, kind: u8, message: *const c_char);
}

/// The most bytes of a message one entry takes: the log stores 1024 bytes
/// of an entry's dynamic content with its metadata and cuts the rest
/// (`<os/log.h>`).
const ENTRY_BYTES: usize = 960;

/// What [`install`] sets up.
#[non_exhaustive]
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// Run by `nsh run`: every line from info up (not only warnings, errors
    /// and the app's `js` lines), and on stderr too, which `nsh run` shows.
    pub development: bool,
    /// What starts each line on stderr: `"[nsh] "` in a host app's output.
    pub stderr_prefix: &'static str,
}

/// Makes the unified log the process's logger, up to info, unless the
/// process has a logger already: an embedding app's own keeps the lines.
/// Returns whether it did. Any thread may call it, any number of times; the
/// first call's options hold.
pub fn install(options: Options) -> bool {
    static LOGGER: OnceLock<Logger> = OnceLock::new();
    let logger = LOGGER.get_or_init(|| Logger::new(options));
    if log::set_logger(logger).is_err() {
        return false;
    }
    log::set_max_level(LevelFilter::Info);
    true
}

struct Logger {
    /// Every line from info up ([`Options::development`]).
    everything: bool,
    /// Lines go to stderr too.
    stderr: bool,
    stderr_prefix: &'static str,
    subsystem: CString,
    categories: Categories<Option<OsLog>>,
}

impl Logger {
    fn new(options: Options) -> Logger {
        Logger {
            everything: options.development,
            stderr: stderr_too(
                options.development,
                goes_somewhere(libc::STDERR_FILENO),
                debugger_console(),
                log_disabled(),
            ),
            stderr_prefix: options.stderr_prefix,
            subsystem: c_string(subsystem()),
            categories: Categories::default(),
        }
    }
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= Level::Warn || metadata.target() == "js" || self.everything
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let mut message = String::new();
        // A `Display` that fails leaves what it wrote before.
        let _ = write!(message, "{}", record.args());
        if self.stderr {
            let _ = writeln!(
                std::io::stderr().lock(),
                "{}{} {}: {message}",
                self.stderr_prefix,
                record.level(),
                record.target()
            );
        }
        let os_log = self.categories.get(record.target(), |category| {
            OsLog::new(&self.subsystem, category)
        });
        let Some(os_log) = os_log else {
            return;
        };
        let kind = LogType::of(record.level());
        for part in parts(&message, ENTRY_BYTES) {
            os_log.write(kind, &entry(record.level(), part));
        }
    }

    fn flush(&self) {}
}

/// A log object (`os_log_t`).
#[derive(Clone, Copy)]
struct OsLog(NonNull<c_void>);

// SAFETY: a log object never changes once made and is never deallocated;
// the os_log functions take it on any thread.
unsafe impl Send for OsLog {}
// SAFETY: as for `Send`.
unsafe impl Sync for OsLog {}

impl OsLog {
    /// The log object of `subsystem` and `category`.
    fn new(subsystem: &CStr, category: &str) -> Option<OsLog> {
        let category = c_string(category.to_owned());
        // SAFETY: two NUL-terminated strings, read during the call (the log
        // keeps its own copies with the object, one per pair).
        let log = unsafe { os_log_create(subsystem.as_ptr(), category.as_ptr()) };
        NonNull::new(log).map(OsLog)
    }

    /// Logs `text` as one entry of type `kind`.
    fn write(self, kind: LogType, text: &CStr) {
        // SAFETY: `self` is a log object from `os_log_create`, `text` a
        // NUL-terminated string the call only reads.
        unsafe { platform_apple_os_log(self.0.as_ptr(), kind as u8, text.as_ptr()) };
    }
}

/// The `os_log_type_t` (`<os/log.h>`) of a record's level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum LogType {
    /// `OS_LOG_TYPE_DEFAULT`: stored, and shown in Console as it comes.
    Default = 0x00,
    /// `OS_LOG_TYPE_DEBUG`: kept only while the log is set to keep debug
    /// entries (`log stream --level debug`, a logging profile).
    Debug = 0x02,
    /// `OS_LOG_TYPE_ERROR`.
    Error = 0x10,
}

impl LogType {
    fn of(level: Level) -> LogType {
        match level {
            Level::Error => LogType::Error,
            // Info too, so `console.log` lines are stored and show in Console
            // without "Include Info Messages".
            Level::Warn | Level::Info => LogType::Default,
            Level::Debug | Level::Trace => LogType::Debug,
        }
    }
}

/// The log object of each category (a record's target), made by `create`
/// on the category's first line.
struct Categories<T> {
    made: Mutex<HashMap<Box<str>, T>>,
}

impl<T> Default for Categories<T> {
    fn default() -> Self {
        Categories {
            made: Mutex::new(HashMap::new()),
        }
    }
}

impl<T: Copy> Categories<T> {
    fn get(&self, category: &str, create: impl FnOnce(&str) -> T) -> T {
        let mut made = self.made.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(&log) = made.get(category) {
            return log;
        }
        let log = create(category);
        made.insert(category.into(), log);
        log
    }
}

/// `message` in parts of at most `max` bytes (a character longer than that
/// is a part of its own), one entry each: split at the last line break that
/// fits, which goes, else after the last character that fits. An empty
/// message is one empty part.
fn parts(message: &str, max: usize) -> impl Iterator<Item = &str> {
    let mut rest = Some(message);
    std::iter::from_fn(move || {
        let text = rest?;
        if text.len() <= max {
            rest = None;
            return Some(text);
        }
        let end = text
            .floor_char_boundary(max)
            .max(text.ceil_char_boundary(1));
        let (part, next) = match text[..end].rfind('\n').filter(|&newline| newline > 0) {
            Some(newline) => (&text[..newline], &text[newline + 1..]),
            None => text.split_at(end),
        };
        rest = (!next.is_empty()).then_some(next);
        Some(part)
    })
}

/// One entry's text: `part`, after `WARN` for a warning, whose type does not
/// say it.
fn entry(level: Level, part: &str) -> CString {
    let prefix = if level == Level::Warn { "WARN " } else { "" };
    let mut text = String::with_capacity(prefix.len() + part.len() + 1);
    text.push_str(prefix);
    text.push_str(part);
    c_string(text)
}

/// `text` as a C string, which ends at its first NUL: each NUL in it is
/// written `\0`, so nothing after one is lost.
fn c_string(text: String) -> CString {
    let text = if text.contains('\0') {
        text.replace('\0', "\\0")
    } else {
        text
    };
    CString::new(text).unwrap_or_default()
}

/// The main bundle's identifier (a packaged app's id, an embedding app's
/// own), else the executable's name.
fn subsystem() -> String {
    NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|id| id.to_string())
        .filter(|id| !id.is_empty())
        .or_else(|| {
            let exe = std::env::current_exe().ok()?;
            Some(exe.file_name()?.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "nsh".to_owned())
}

/// Whether lines go to stderr as well: where `nsh run` shows it
/// (`development`), or wherever else stderr goes (`goes_somewhere`) unless a
/// debugger's console shows the log already, which it does not while the
/// process's log is off (`log_disabled`).
fn stderr_too(
    development: bool,
    goes_somewhere: bool,
    debugger_console: bool,
    log_disabled: bool,
) -> bool {
    development || (goes_somewhere && (log_disabled || !debugger_console))
}

/// Whether `fd` is open and not `/dev/null`, where launchd points the
/// stderr of an app opened from Finder, the Dock or the Home screen: a
/// terminal, a file or a pipe someone may read.
fn goes_somewhere(fd: RawFd) -> bool {
    let mut file = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `fstat` only writes the buffer, and fills it when it succeeds;
    // a closed or invalid `fd` makes it fail.
    if unsafe { libc::fstat(fd, file.as_mut_ptr()) } != 0 {
        return false;
    }
    // SAFETY: `fstat` succeeded, so it filled the buffer.
    let file = unsafe { file.assume_init() };
    let mut null = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: a NUL-terminated path; `stat` only writes the buffer, and fills
    // it when it succeeds.
    if unsafe { libc::stat(c"/dev/null".as_ptr(), null.as_mut_ptr()) } != 0 {
        return true;
    }
    // SAFETY: `stat` succeeded, so it filled the buffer.
    let null = unsafe { null.assume_init() };
    // The null device, by whichever node it was opened.
    let device = |st: &libc::stat| st.st_mode & libc::S_IFMT == libc::S_IFCHR;
    !(device(&file) && device(&null) && file.st_rdev == null.st_rdev)
}

/// Whether a debugger's console shows the unified log: Xcode's, which
/// streams it (Xcode 15 on, `IDE_DISABLED_OS_ACTIVITY_DT_MODE`) or has it
/// copied to stderr (`OS_ACTIVITY_DT_MODE`).
fn debugger_console() -> bool {
    ["IDE_DISABLED_OS_ACTIVITY_DT_MODE", "OS_ACTIVITY_DT_MODE"]
        .into_iter()
        .any(|name| std::env::var_os(name).is_some())
}

/// Whether the process's log is off: `OS_ACTIVITY_MODE=disable`, which an
/// Xcode scheme sets to quiet the system's own lines, and which turns off
/// this logger's entries as well.
fn log_disabled() -> bool {
    std::env::var_os("OS_ACTIVITY_MODE").is_some_and(|mode| mode == "disable")
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use log::{Level, Log, Metadata, Record};

    use super::{
        Categories, ENTRY_BYTES, LogType, Logger, c_string, entry, goes_somewhere, parts,
        stderr_too, subsystem,
    };

    fn logger(everything: bool) -> Logger {
        Logger {
            everything,
            stderr: false,
            stderr_prefix: "",
            subsystem: c_string(subsystem()),
            categories: Categories::default(),
        }
    }

    #[test]
    fn levels_take_the_log_types() {
        assert_eq!(LogType::of(Level::Error), LogType::Error);
        assert_eq!(LogType::of(Level::Warn), LogType::Default);
        assert_eq!(LogType::of(Level::Info), LogType::Default);
        assert_eq!(LogType::of(Level::Debug), LogType::Debug);
        assert_eq!(LogType::of(Level::Trace), LogType::Debug);
        // `os_log_type_t`'s values in <os/log.h>.
        assert_eq!(LogType::Default as u8, 0x00);
        assert_eq!(LogType::Debug as u8, 0x02);
        assert_eq!(LogType::Error as u8, 0x10);
    }

    #[test]
    fn warnings_errors_and_js_lines_are_logged() {
        fn line(level: Level, target: &str) -> Metadata<'_> {
            Metadata::builder().level(level).target(target).build()
        }
        let release = logger(false);
        assert!(release.enabled(&line(Level::Error, "nsh_engine::updates")));
        assert!(release.enabled(&line(Level::Warn, "nsh_core::core")));
        assert!(release.enabled(&line(Level::Info, "js")));
        assert!(!release.enabled(&line(Level::Info, "nsh_engine::updates")));
        assert!(logger(true).enabled(&line(Level::Info, "nsh_engine::updates")));
    }

    #[test]
    fn a_warning_says_so() {
        assert_eq!(entry(Level::Warn, "low disk").as_bytes(), b"WARN low disk");
        assert_eq!(entry(Level::Error, "failed").as_bytes(), b"failed");
        assert_eq!(entry(Level::Info, "loaded").as_bytes(), b"loaded");
    }

    #[test]
    fn a_nul_keeps_what_follows_it() {
        assert_eq!(c_string("a\0b\0".to_owned()).as_bytes(), b"a\\0b\\0");
        assert_eq!(entry(Level::Warn, "x\0y").as_bytes(), b"WARN x\\0y");
        assert_eq!(c_string("plain".to_owned()).as_bytes(), b"plain");
    }

    #[test]
    fn each_category_is_made_once() {
        let categories = Categories::default();
        let made = Cell::new(0);
        let get = |category| {
            categories.get(category, |_| {
                made.set(made.get() + 1);
                made.get()
            })
        };
        assert_eq!(get("js"), 1);
        assert_eq!(get("nsh_engine::updates"), 2);
        assert_eq!(get("js"), 1);
        assert_eq!(made.get(), 2);
    }

    #[test]
    fn long_messages_are_split_between_lines() {
        let parts = |message, max| parts(message, max).collect::<Vec<_>>();
        assert_eq!(parts("", 8), [""]);
        assert_eq!(parts("one line", 8), ["one line"]);
        assert_eq!(
            parts("error\n  at a\n  at b", 8),
            ["error", "  at a", "  at b"]
        );
        assert_eq!(parts("\nabcdef", 4), ["\nabc", "def"]);
        // No line break that fits: cut at the last whole character.
        assert_eq!(parts("abcdefghij", 4), ["abcd", "efgh", "ij"]);
        assert_eq!(parts("ééééé", 4), ["éé", "éé", "é"]);
        // A character longer than a part still goes.
        assert_eq!(parts("😀😀", 2), ["😀", "😀"]);
        let long = "x".repeat(ENTRY_BYTES * 2 + 1);
        assert!(
            parts(&long, ENTRY_BYTES)
                .iter()
                .all(|part| part.len() <= ENTRY_BYTES)
        );
        assert_eq!(parts(&long, ENTRY_BYTES).concat(), long);
    }

    #[test]
    fn lines_go_to_stderr_where_someone_reads_it() {
        // `nsh run`, whatever the rest says.
        assert!(stderr_too(true, false, false, false));
        assert!(stderr_too(true, true, true, false));
        // A terminal, a file (`2> app.log`, launchd's `StandardErrorPath`),
        // a pipe.
        assert!(stderr_too(false, true, false, false));
        // Finder, the Dock, the Home screen: /dev/null.
        assert!(!stderr_too(false, false, false, false));
        assert!(!stderr_too(false, false, false, true));
        // Xcode's console shows the log already...
        assert!(!stderr_too(false, true, true, false));
        // ...unless the scheme turned the log off (`OS_ACTIVITY_MODE=disable`).
        assert!(stderr_too(false, true, true, true));
    }

    #[test]
    fn dev_null_is_nowhere() {
        use std::os::fd::AsRawFd as _;

        let null = std::fs::File::open("/dev/null").unwrap();
        assert!(!goes_somewhere(null.as_raw_fd()));
        let path = std::env::temp_dir().join(format!("nsh-unified-log-{}", std::process::id()));
        let file = std::fs::File::create(&path).unwrap();
        assert!(goes_somewhere(file.as_raw_fd()));
        drop(file);
        std::fs::remove_file(&path).unwrap();
        let (reader, writer) = std::io::pipe().unwrap();
        assert!(goes_somewhere(writer.as_raw_fd()));
        drop(reader);
        // Closed.
        assert!(!goes_somewhere(-1));
    }

    #[test]
    fn logs_through_the_unified_log() {
        let logger = logger(true);
        let long = format!("a long line: {}", "x".repeat(ENTRY_BYTES * 2));
        for level in [Level::Error, Level::Warn, Level::Info, Level::Debug] {
            for target in ["js", "nsh_platform_apple::tests"] {
                logger.log(
                    &Record::builder()
                        .level(level)
                        .target(target)
                        .args(format_args!("unified log test, a NUL: \0, then {long}"))
                        .build(),
                );
            }
        }
    }
}
