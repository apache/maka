//! `log` facade -> Android's log (`adb logcat -s nsh`), or the dev server's
//! terminal while connected (development builds).

use std::ffi::{CString, c_char, c_int};

#[link(name = "log")]
unsafe extern "C" {
    fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

struct Logger;

impl log::Log for Logger {
    /// Info and up: nsh's, JS's and a Rust app's own logs.
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = record.args().to_string();
        #[cfg(feature = "dev")]
        if crate::dev::forward(record.level(), record.target(), &message) {
            return;
        }
        let priority = match record.level() {
            log::Level::Error => 6,
            log::Level::Warn => 5,
            log::Level::Info => 4,
            log::Level::Debug => 3,
            log::Level::Trace => 2,
        };
        let text = CString::new(format!("{}: {message}", record.target()).replace('\0', " "))
            .unwrap_or_default();
        // SAFETY: valid NUL-terminated strings.
        unsafe { __android_log_write(priority, c"nsh".as_ptr(), text.as_ptr()) };
    }

    fn flush(&self) {}
}

pub(crate) fn init() {
    static LOGGER: Logger = Logger;
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}
