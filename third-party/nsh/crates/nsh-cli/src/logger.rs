//! The `log` backend of the command line, and how log lines are shown,
//! from this process and from devices (`dev.rs`): normally in the style of
//! `ui.rs`, without targets; verbose runs show every line with its level
//! and target.
//!
//! Shown normally: warnings and errors, the app's own output (`js`, and
//! a device's lines from other crates: the app's Rust code) and the timings
//! of `--trace` (`nsh::perf`). nsh's own info lines (a device's "loading
//! build 3") and the performance monitor's line a second (`--fps`,
//! `nsh::fps`) are for verbose runs; the CLI says what happens in its steps.

use log::{Level, LevelFilter, Log, Metadata, Record};
use nsh_dev::protocol::LogLevel;

use crate::ui;

struct Logger;

/// Installs the logger (after [`ui::init`]).
pub(crate) fn init() {
    static LOGGER: Logger = Logger;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(if ui::verbose() {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    });
}

/// Where a device's line comes from.
pub(crate) struct Device<'a> {
    /// The device's full name, for verbose runs.
    pub(crate) name: &'a str,
    /// Its short name, for normal lines.
    pub(crate) label: &'a str,
    /// More than one device is connected: the app's own output says which.
    pub(crate) several: bool,
}

/// Shows a log line of a process run for this command (an app's headless
/// runner), as this process's own would be.
pub(crate) fn forward(level: Level, target: &str, message: &str) {
    let metadata = Metadata::builder().level(level).target(target).build();
    if level <= log::max_level() && Logger.enabled(&metadata) {
        show(level, target, message, None);
    }
}

/// Shows a log line of a device.
pub(crate) fn device(device: &Device<'_>, level: LogLevel, target: &str, message: &str) {
    let level = match level {
        LogLevel::Error => Level::Error,
        LogLevel::Warn => Level::Warn,
        LogLevel::Info => Level::Info,
        LogLevel::Debug => Level::Debug,
        LogLevel::Trace => Level::Trace,
    };
    show(level, target, message, Some(device));
}

fn show(level: Level, target: &str, message: &str, device: Option<&Device<'_>>) {
    if ui::verbose() {
        let source = match device {
            Some(device) => format!("{} {target}", device.name),
            None => source(target),
        };
        let tag = match level {
            Level::Error => ui::red("error"),
            Level::Warn => ui::yellow(" warn"),
            Level::Info => ui::green(" info"),
            Level::Debug => ui::cyan("debug"),
            Level::Trace => ui::dim("trace"),
        };
        return ui::plain(format!("{tag} {} {message}", ui::dim(source)));
    }
    let from = |sep: &str| device.map_or(String::new(), |d| format!("{}{sep}", d.label));
    match level {
        Level::Error => ui::error(format!("{}{message}", from(": "))),
        Level::Warn => ui::warn(format!("{}{message}", from(": "))),
        _ if target == "nsh::perf" => ui::plain(format!(
            "{} {}{message}",
            ui::dim("perf"),
            ui::dim(from(": "))
        )),
        // nsh's own: the steps say it.
        _ if target.starts_with("nsh") => {}
        // The app's: its `console.*`, a device's Rust code.
        _ => match device {
            Some(device) if device.several => ui::plain(format!(
                "{}{message}",
                ui::dim(format!("{}: ", device.label))
            )),
            _ => ui::plain(message),
        },
    }
}

/// A target as verbose lines show it: the command line's own modules as
/// they are (`nsh::build`, the binary's name), other crates without `nsh_`
/// (`bundler::...`).
fn source(target: &str) -> String {
    target.strip_prefix("nsh_").unwrap_or(target).to_owned()
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        // Ours and the app's (`js`); dependencies (rolldown, axum, ...) only
        // when they are loud.
        let target = metadata.target();
        target.starts_with("nsh") || target == "js" || metadata.level() <= Level::Warn
    }

    fn log(&self, record: &Record<'_>) {
        if self.enabled(record.metadata()) {
            show(
                record.level(),
                record.target(),
                &record.args().to_string(),
                None,
            );
        }
    }

    fn flush(&self) {}
}
