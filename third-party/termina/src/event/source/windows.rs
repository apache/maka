// CREDIT: This one is shared between crossterm and termwiz but is mostly termwiz.
// Termwiz: <https://github.com/wezterm/wezterm/blame/a87358516004a652ad840bc1661bdf65ffc89b43/termwiz/src/terminal/windows.rs#L810-L853>
// Crossterm: <https://github.com/crossterm-rs/crossterm/blob/36d95b26a26e64b0f8c12edfe11f410a6d56a812/src/event/source/windows.rs>
// Also see the necessary methods on the handle from the terminal module and the credit comment
// there.
use std::{io, os::windows::prelude::*, ptr, sync::Arc, time::Duration};

use windows_sys::Win32::System::Threading;

use crate::{event::Event, parse::Parser, terminal::InputHandle, windows::InputReaderMode};

use super::{EventSource, PollTimeout};

#[derive(Debug)]
pub struct WindowsEventSource {
    input: InputHandle,
    parser: Parser,
    waker: Arc<EventHandle>,
}

impl WindowsEventSource {
    pub(crate) fn new(input: InputHandle, mode: InputReaderMode) -> io::Result<Self> {
        Ok(Self {
            input,
            parser: Parser::with_mode(mode),
            waker: Arc::new(EventHandle::new()?),
        })
    }
}

impl EventSource for WindowsEventSource {
    fn wait_ready(&mut self) -> io::Result<()> {
        use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
        use Threading::{WaitForMultipleObjects, INFINITE};

        if self.parser.is_ready() || self.input.has_pending_input_events()? {
            return Ok(());
        }
        let mut handles = [self.input.as_raw_handle(), self.waker.as_raw_handle()];
        let wait = self
            .parser
            .reply_poll_timeout(None)
            .map(|timeout| {
                // Windows waits in whole milliseconds. Round up without turning a finite
                // parser deadline into INFINITE or repeatedly polling its final fraction.
                let millis =
                    timeout.as_millis() + u128::from(timeout.subsec_nanos() % 1_000_000 != 0);
                millis.min(u128::from(INFINITE - 1)) as u32
            })
            .unwrap_or(INFINITE);
        let result =
            unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_mut_ptr(), 0, wait) };
        match result {
            WAIT_OBJECT_0 | WAIT_TIMEOUT => Ok(()),
            value if value == WAIT_OBJECT_0 + 1 => Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Readiness wait was woken up",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Err(io::Error::new(
                io::ErrorKind::Other,
                "unexpected terminal readiness wait result",
            )),
        }
    }

    fn set_max_pending_bytes(&mut self, limit: usize) -> io::Result<()> {
        self.parser.set_max_pending_bytes(limit)
    }

    fn waker(&self) -> WindowsWaker {
        WindowsWaker {
            handle: self.waker.clone(),
        }
    }

    fn try_read(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0};
        use Threading::{WaitForMultipleObjects, INFINITE};

        let timeout = PollTimeout::new(timeout);

        loop {
            self.parser.expire_reply_at(std::time::Instant::now())?;
            if let Some(event) = self.parser.pop() {
                return Ok(Some(event));
            }

            if !self.input.has_pending_input_events()? {
                let mut handles = [self.input.as_raw_handle(), self.waker.as_raw_handle()];
                let wait = self
                    .parser
                    .reply_poll_timeout(timeout.leftover())
                    .map(|timeout| timeout.as_millis() as u32)
                    .unwrap_or(INFINITE);
                let result = unsafe {
                    WaitForMultipleObjects(handles.len() as u32, handles.as_mut_ptr(), 0, wait)
                };
                self.parser.expire_reply_at(std::time::Instant::now())?;

                if result == WAIT_OBJECT_0 {
                    // The input handle is signaled: there is input ready to be read. Fall through
                    // to `read_console_input` below.
                } else if result == WAIT_OBJECT_0 + 1 {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "Poll operation was woken up",
                    ));
                } else if result == WAIT_FAILED {
                    return Err(io::Error::new(
                        io::ErrorKind::Other,
                        format!(
                            "failed to poll input handles: {}",
                            io::Error::last_os_error()
                        ),
                    ));
                } else {
                    // `WAIT_TIMEOUT` (or an abandoned handle): no event arrived within the timeout.
                    if timeout.leftover().is_some_and(|left| left.is_zero()) {
                        return Ok(None);
                    }
                    continue;
                }
            }

            let records = self.input.read_console_input()?;

            self.parser.decode_input_records(records)?;

            // Decoding the records may have produced an event (a key press, a resize, a parsed VT
            // sequence). Return it before honoring a zero timeout, otherwise a non-blocking poll
            // would discard input it just read.
            if let Some(event) = self.parser.pop() {
                return Ok(Some(event));
            }

            if timeout.leftover().is_some_and(|t| t.is_zero()) {
                break;
            }
        }

        Ok(None)
    }
}

#[derive(Debug)]
struct EventHandle {
    handle: OwnedHandle,
}

impl EventHandle {
    fn new() -> io::Result<Self> {
        let handle = unsafe { Threading::CreateEventW(ptr::null(), 0, 0, ptr::null()) };
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
            Ok(Self { handle })
        }
    }
}

impl AsRawHandle for EventHandle {
    fn as_raw_handle(&self) -> RawHandle {
        self.handle.as_raw_handle()
    }
}

/// A handle that can unblock a pending [`EventReader::poll`](crate::EventReader::poll) call
/// from another thread.
///
/// Cloning this type is cheap. All clones wake the same underlying reader.
#[derive(Debug, Clone)]
pub struct WindowsWaker {
    handle: Arc<EventHandle>,
}

impl WindowsWaker {
    /// Unblocks a pending [`EventReader::poll`](crate::EventReader::poll) call.
    pub fn wake(&self) -> io::Result<()> {
        if unsafe { Threading::SetEvent(self.handle.as_raw_handle()) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}
