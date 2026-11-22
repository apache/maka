//! The host, rather than the event parser, owns terminal lifetime and I/O waits.

use std::{
    io::{self, IsTerminal},
    time::Duration,
};

const OUTPUT_WAIT: Duration = Duration::from_millis(16);

pub(super) struct Transport {
    flags: Vec<(libc::c_int, libc::c_int)>,
}

impl Transport {
    pub(super) fn enter() -> io::Result<Self> {
        if !io::stdin().is_terminal() {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "interactive terminal input is closed or redirected; use --headless for tests",
            ));
        }
        let mut transport = Self { flags: Vec::new() };
        // Capture both before changing either: inherited stdin and stdout may share an open file description.
        for fd in [libc::STDIN_FILENO, libc::STDOUT_FILENO] {
            // SAFETY: fcntl checks a process-owned standard descriptor without dereferencing memory.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 {
                return Err(io::Error::last_os_error());
            }
            transport.flags.push((fd, flags));
        }
        for &(fd, flags) in &transport.flags {
            // SAFETY: these descriptors and their saved flags were checked above.
            if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(transport)
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        for &(fd, flags) in &self.flags {
            // SAFETY: restores the original flags of a standard descriptor owned by the host.
            unsafe {
                libc::fcntl(fd, libc::F_SETFL, flags);
            }
        }
    }
}

pub(super) fn disconnected() -> io::Result<bool> {
    if !io::stdin().is_terminal() {
        return Ok(true);
    }
    #[cfg(target_os = "macos")]
    if input_at_eof()? {
        return Ok(true);
    }
    let mut fds = [libc::STDIN_FILENO, libc::STDOUT_FILENO].map(|fd| libc::pollfd {
        fd,
        events: 0,
        revents: 0,
    });
    // SAFETY: fds points to two initialized pollfd values. This is a nonblocking lifetime check.
    if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(fds
        .iter()
        .any(|fd| fd.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0))
}

#[cfg(target_os = "macos")]
fn input_at_eof() -> io::Result<bool> {
    // macOS poll can omit HUP for a PTY without a controlling session. A readable
    // raw-mode input with no queued bytes is EOF; inspect it without consuming input.
    // SAFETY: zero is a valid empty fd_set and timeval; only stdin is added to the set.
    let mut readable: libc::fd_set = unsafe { std::mem::zeroed() };
    let mut timeout = libc::timeval {
        tv_sec: 0,
        tv_usec: 0,
    };
    // SAFETY: the initialized set and timeout remain valid throughout the nonblocking call.
    let ready = unsafe {
        libc::FD_SET(libc::STDIN_FILENO, &mut readable);
        libc::select(
            1,
            &mut readable,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut timeout,
        )
    };
    if ready < 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::Interrupted {
            Ok(false)
        } else {
            Err(error)
        };
    }
    if ready == 0 {
        return Ok(false);
    }
    let mut queued: libc::c_int = 0;
    // SAFETY: FIONREAD writes the number of queued bytes to the initialized integer.
    if unsafe { libc::ioctl(libc::STDIN_FILENO, libc::FIONREAD as _, &mut queued) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(queued == 0)
}

pub(super) fn write(bytes: &[u8]) -> io::Result<usize> {
    loop {
        if crate::shutdown::requested() {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "terminal host is shutting down",
            ));
        }
        if disconnected()? {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "terminal disconnected",
            ));
        }
        // SAFETY: bytes is readable for its length; stdout is nonblocking for the session's lifetime.
        let written =
            unsafe { libc::write(libc::STDOUT_FILENO, bytes.as_ptr().cast(), bytes.len()) };
        if written >= 0 {
            return Ok(written as usize);
        }
        let error = io::Error::last_os_error();
        match error.kind() {
            io::ErrorKind::Interrupted => continue,
            io::ErrorKind::WouldBlock => {
                let mut fd = libc::pollfd {
                    fd: libc::STDOUT_FILENO,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                // SAFETY: fd is initialized and remains live for this bounded wait.
                let ready =
                    unsafe { libc::poll(&mut fd, 1, OUTPUT_WAIT.as_millis() as libc::c_int) };
                if ready < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                } else if fd.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "terminal output disconnected",
                    ));
                }
            }
            _ => return Err(error),
        }
    }
}

pub(super) fn restore(mut bytes: &[u8]) {
    // Cleanup is best-effort even on a full/disconnected PTY. Never wait for output here.
    while !bytes.is_empty() {
        // SAFETY: bytes is live; stdout remains nonblocking until the transport guard drops.
        let written =
            unsafe { libc::write(libc::STDOUT_FILENO, bytes.as_ptr().cast(), bytes.len()) };
        if written <= 0 {
            if written < 0 && io::Error::last_os_error().kind() == io::ErrorKind::WouldBlock {
                // macOS can wait for a full controlling PTY's output during process teardown,
                // even after SIGKILL. Discard undeliverable output rather than waiting to close it.
                // SAFETY: this session owns stdout; TCOFLUSH discards its pending terminal output.
                unsafe {
                    libc::tcflush(libc::STDOUT_FILENO, libc::TCOFLUSH);
                }
            }
            break;
        }
        bytes = &bytes[written as usize..];
    }
}

/// Writes `query` to the terminal and collects its answers from stdin until the
/// primary device attributes arrive or `timeout` passes. Runs in raw mode before
/// crossterm's reader starts, so nothing else reads these bytes.
pub(super) fn query(query: &[u8], timeout: Duration) -> io::Result<Vec<u8>> {
    // SAFETY: isatty only inspects the descriptors.
    if unsafe { libc::isatty(libc::STDIN_FILENO) == 0 || libc::isatty(libc::STDOUT_FILENO) == 0 } {
        // Nothing would answer: no wait at all.
        return Ok(Vec::new());
    }
    let mut written = 0;
    let deadline = std::time::Instant::now() + timeout;
    while written < query.len() {
        let n = write(&query[written..])?;
        written += n;
        if std::time::Instant::now() >= deadline {
            return Ok(Vec::new());
        }
    }
    let mut replies = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() || super::parse_replies(&replies).complete {
            return Ok(replies);
        }
        let mut fd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        let wait = left.as_millis().clamp(1, i32::MAX as u128) as libc::c_int;
        // SAFETY: fd is initialized and live for this bounded wait.
        let ready = unsafe { libc::poll(&mut fd, 1, wait) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if ready == 0 {
            continue;
        }
        if fd.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            return Ok(replies);
        }
        // SAFETY: chunk is writable for its length; stdin is nonblocking for the session.
        let read =
            unsafe { libc::read(libc::STDIN_FILENO, chunk.as_mut_ptr().cast(), chunk.len()) };
        if read > 0 {
            replies.extend_from_slice(&chunk[..read as usize]);
        } else if read == 0 {
            return Ok(replies);
        } else {
            let error = io::Error::last_os_error();
            if !matches!(
                error.kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            ) {
                return Err(error);
            }
        }
    }
}
