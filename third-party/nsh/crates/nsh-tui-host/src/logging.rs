use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::Mutex,
};

struct Logger(Mutex<Option<File>>);
static LOGGER: Logger = Logger(Mutex::new(None));

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target().starts_with("nsh")
            || metadata.target() == "js"
            || metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata())
            && let Some(file) = LOGGER.0.lock().unwrap_or_else(|e| e.into_inner()).as_mut()
        {
            let _ = writeln!(
                file,
                "{} {}: {}",
                record.level(),
                record.target(),
                record.args()
            );
        }
    }
    fn flush(&self) {}
}

pub(crate) fn init(path: &Path, trace: bool) -> io::Result<()> {
    *LOGGER.0.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(OpenOptions::new().create(true).append(true).open(path)?);
    let _ = log::set_logger(&LOGGER);
    // console.log is an Info record; trace controls engine timings, not app logs.
    log::set_max_level(if trace {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    });
    Ok(())
}
