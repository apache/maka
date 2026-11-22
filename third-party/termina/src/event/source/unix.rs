// CREDIT: This is mostly a mirror of crossterm `tty` event source adjusted to use rustix
// exclusively, reaching into parts of the `filedescriptor` dependency (NOTE: which is part of the
// WezTerm repo) but reimplementing with rustix instead of libc.
// Crossterm: <https://github.com/crossterm-rs/crossterm/blob/36d95b26a26e64b0f8c12edfe11f410a6d56a812/src/event/source/unix/tty.rs>
// Termwiz: <https://github.com/wezterm/wezterm/blob/a87358516004a652ad840bc1661bdf65ffc89b43/filedescriptor/src/unix.rs#L444-L584>
use std::{
    io::{self, Read, Write as _},
    os::{
        fd::{AsFd, BorrowedFd},
        unix::net::UnixStream,
    },
    sync::Arc,
    time::Duration,
};

use parking_lot::Mutex;
use rustix::termios;

use crate::{parse::Parser, terminal::FileDescriptor, Event};

use super::{EventSource, PollTimeout};

#[derive(Debug)]
pub struct UnixEventSource {
    parser: Parser,
    read: FileDescriptor,
    write: FileDescriptor,
    sigwinch_id: signal_hook::SigId,
    sigwinch_pipe: UnixStream,
    wake_pipe: UnixStream,
    wake_pipe_write: Arc<Mutex<UnixStream>>,
}

/// A handle that can unblock a pending [`EventReader::poll`](crate::EventReader::poll) call
/// from another thread.
///
/// Cloning this type is cheap. All clones wake the same underlying reader.
#[derive(Debug, Clone)]
pub struct UnixWaker {
    inner: Arc<Mutex<UnixStream>>,
}

impl UnixWaker {
    /// Unblocks a pending [`EventReader::poll`](crate::EventReader::poll) call.
    pub fn wake(&self) -> io::Result<()> {
        self.inner.lock().write_all(&[0])
    }
}

impl UnixEventSource {
    pub(crate) fn new(read: FileDescriptor, write: FileDescriptor) -> io::Result<Self> {
        let (sigwinch_pipe, sigwinch_pipe_write) = UnixStream::pair()?;
        let sigwinch_id = signal_hook::low_level::pipe::register(
            signal_hook::consts::SIGWINCH,
            sigwinch_pipe_write,
        )?;
        sigwinch_pipe.set_nonblocking(true)?;
        let (wake_pipe, wake_pipe_write) = UnixStream::pair()?;
        wake_pipe.set_nonblocking(true)?;
        wake_pipe_write.set_nonblocking(true)?;

        Ok(Self {
            parser: Default::default(),
            read,
            write,
            sigwinch_id,
            sigwinch_pipe,
            wake_pipe,
            wake_pipe_write: Arc::new(Mutex::new(wake_pipe_write)),
        })
    }
}

impl Drop for UnixEventSource {
    fn drop(&mut self) {
        signal_hook::low_level::unregister(self.sigwinch_id);
    }
}

impl EventSource for UnixEventSource {
    fn wait_ready(&mut self) -> io::Result<()> {
        if self.parser.is_ready() {
            return Ok(());
        }
        let [_, _, wake_ready] = poll(
            [
                self.read.as_fd(),
                self.sigwinch_pipe.as_fd(),
                self.wake_pipe.as_fd(),
            ],
            self.parser.reply_poll_timeout(None),
        )?;
        if wake_ready {
            while read_complete(&self.wake_pipe, &mut [0; 1024])? != 0 {}
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Readiness wait was woken up",
            ));
        }
        Ok(())
    }

    fn set_max_pending_bytes(&mut self, limit: usize) -> io::Result<()> {
        self.parser.set_max_pending_bytes(limit)
    }

    fn waker(&self) -> UnixWaker {
        UnixWaker {
            inner: self.wake_pipe_write.clone(),
        }
    }

    fn try_read(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        let timeout = PollTimeout::new(timeout);

        loop {
            self.parser.expire_reply_at(std::time::Instant::now())?;
            if let Some(event) = self.parser.pop() {
                return Ok(Some(event));
            }

            let [read_ready, sigwinch_ready, wake_ready] = match poll(
                [
                    self.read.as_fd(),
                    self.sigwinch_pipe.as_fd(),
                    self.wake_pipe.as_fd(),
                ],
                self.parser.reply_poll_timeout(timeout.leftover()),
            ) {
                Ok(ready) => ready,
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(err) => return Err(err),
            };
            self.parser.expire_reply_at(std::time::Instant::now())?;

            // The input/read pipe has data.
            if read_ready {
                let mut buffer = [0u8; 1024];
                let read_count = read_complete(&mut self.read, &mut buffer)?;
                if read_count == 0 {
                    // `poll` reported the read side ready but no bytes are available. On a blocking
                    // fd (the `fionbio` call in the terminal module is disabled) that means
                    // end-of-file: the terminal input was closed, e.g. the pty master went away.
                    // Returning `Ok(None)` here would busy-loop at 100% CPU because `poll` keeps
                    // reporting EOF as readable, so surface it as an error and let the caller stop.
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "terminal input reached end-of-file",
                    ));
                }
                self.parser
                    .parse(&buffer[..read_count], read_count == buffer.len())?;
                if let Some(event) = self.parser.pop() {
                    return Ok(Some(event));
                }
            }

            // SIGWINCH received.
            if sigwinch_ready {
                // Drain the pipe.
                while read_complete(&self.sigwinch_pipe, &mut [0; 1024])? != 0 {}

                let winsize = termios::tcgetwinsize(&self.write)?;
                let event = Event::WindowResized(winsize.into());
                return Ok(Some(event));
            }

            // Waker has awoken.
            if wake_ready {
                // Drain the pipe.
                while read_complete(&self.wake_pipe, &mut [0; 1024])? != 0 {}

                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Poll operation was woken up",
                ));
            }

            if timeout.leftover().is_some_and(|t| t.is_zero()) {
                break;
            }
        }

        Ok(None)
    }
}

fn read_complete<F: Read>(mut file: F, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        match file.read(buf) {
            Ok(read) => return Ok(read),
            Err(err) => match err.kind() {
                io::ErrorKind::WouldBlock => return Ok(0),
                io::ErrorKind::Interrupted => continue,
                _ => return Err(err),
            },
        }
    }
}

/// A small abstraction over platform specific polling behavior.
///
/// macOS `poll(2)` doesn't work on file descriptors to `/dev/tty` so we need to use `select(2)`
/// instead. This provides a function which abstracts over input readiness from `poll(2)` and
/// `select(2)` without consuming terminal bytes.
///
/// This module is not meant to be generic. Read hangup reaches the original read/EOF path, while
/// other descriptor errors are reported directly. We only allow polling exactly three FDs at
/// a time - the exact amount we need for the event source.
fn poll(fds: [BorrowedFd<'_>; 3], timeout: Option<Duration>) -> std::io::Result<[bool; 3]> {
    use rustix::event::Timespec;

    #[cfg(not(target_os = "macos"))]
    fn poll2(fds: [BorrowedFd<'_>; 3], timeout: Option<&Timespec>) -> io::Result<[bool; 3]> {
        use rustix::event::{PollFd, PollFlags};
        let mut fds = [
            PollFd::new(&fds[0], PollFlags::IN),
            PollFd::new(&fds[1], PollFlags::IN),
            PollFd::new(&fds[2], PollFlags::IN),
        ];

        rustix::event::poll(&mut fds, timeout)?;

        if fds
            .iter()
            .any(|fd| fd.revents().intersects(PollFlags::ERR | PollFlags::NVAL))
        {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "terminal event descriptor failed",
            ));
        }
        if fds[1..]
            .iter()
            .any(|fd| fd.revents().contains(PollFlags::HUP))
        {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "terminal event notification pipe closed",
            ));
        }

        Ok([
            fds[0].revents().intersects(PollFlags::IN | PollFlags::HUP),
            fds[1].revents().contains(PollFlags::IN),
            fds[2].revents().contains(PollFlags::IN),
        ])
    }

    #[cfg(target_os = "macos")]
    fn select2(fds: [BorrowedFd<'_>; 3], timeout: Option<&Timespec>) -> io::Result<[bool; 3]> {
        use rustix::event::{fd_set_insert, fd_set_num_elements, FdSetElement, FdSetIter};
        use std::os::fd::AsRawFd;

        let fds = [fds[0].as_raw_fd(), fds[1].as_raw_fd(), fds[2].as_raw_fd()];
        // The array is non-empty so `max()` cannot return `None`.
        let nfds = fds.iter().copied().max().unwrap() + 1;

        let mut readfds = vec![FdSetElement::default(); fd_set_num_elements(fds.len(), nfds)];
        for fd in fds {
            fd_set_insert(&mut readfds, fd);
        }

        unsafe { rustix::event::select(nfds, Some(&mut readfds), None, None, timeout) }?;

        let mut ready = [false; 3];
        for (fd, is_ready) in fds.iter().copied().zip(ready.iter_mut()) {
            if FdSetIter::new(&readfds).any(|set_fd| set_fd == fd) {
                *is_ready = true;
            }
        }
        Ok(ready)
    }

    #[cfg(not(target_os = "macos"))]
    use poll2 as poll_impl;
    #[cfg(target_os = "macos")]
    use select2 as poll_impl;

    let timespec = timeout.map(|timeout| timeout.try_into().unwrap());
    poll_impl(fds, timespec.as_ref())
}
