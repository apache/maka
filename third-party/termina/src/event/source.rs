#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::time::{Duration, Instant};

#[cfg(unix)]
pub(crate) use unix::UnixEventSource;
#[cfg(unix)]
pub use unix::UnixWaker;
#[cfg(windows)]
pub(crate) use windows::WindowsEventSource;
#[cfg(windows)]
pub use windows::WindowsWaker;

#[cfg(unix)]
pub(crate) type PlatformEventSource = UnixEventSource;
#[cfg(windows)]
pub(crate) type PlatformEventSource = WindowsEventSource;

#[cfg(unix)]
pub type PlatformWaker = UnixWaker;
#[cfg(windows)]
pub type PlatformWaker = WindowsWaker;

// CREDIT: <https://github.com/crossterm-rs/crossterm/blob/36d95b26a26e64b0f8c12edfe11f410a6d56a812/src/event/source.rs#L12-L27>
pub(crate) trait EventSource: Send + Sync {
    fn wait_ready(&mut self) -> std::io::Result<()>;

    fn try_read(&mut self, timeout: Option<Duration>) -> std::io::Result<Option<crate::Event>>;

    fn set_max_pending_bytes(&mut self, limit: usize) -> std::io::Result<()>;

    fn waker(&self) -> PlatformWaker;
}

// CREDIT: <https://github.com/crossterm-rs/crossterm/blob/36d95b26a26e64b0f8c12edfe11f410a6d56a812/src/event/timeout.rs#L5-L40>
#[derive(Debug, Clone)]
pub(crate) struct PollTimeout {
    timeout: Option<Duration>,
    start: Instant,
}

impl PollTimeout {
    pub fn new(timeout: Option<Duration>) -> Self {
        Self {
            timeout,
            start: Instant::now(),
        }
    }

    pub fn elapsed(&self) -> bool {
        self.timeout
            .map(|timeout| self.start.elapsed() >= timeout)
            .unwrap_or(false)
    }

    pub fn leftover(&self) -> Option<Duration> {
        self.timeout.map(|timeout| {
            let elapsed = self.start.elapsed();

            if elapsed >= timeout {
                Duration::ZERO
            } else {
                timeout - elapsed
            }
        })
    }
}
