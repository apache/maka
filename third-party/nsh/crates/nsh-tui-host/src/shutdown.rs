use std::sync::atomic::{AtomicBool, Ordering};

static REQUESTED: AtomicBool = AtomicBool::new(false);

pub(crate) fn requested() -> bool {
    REQUESTED.load(Ordering::Relaxed)
}

/// Asks the running host to leave its run loop and restore the terminal, as SIGTERM does.
///
/// A request made before the host starts its run (an embedding program that spawns the host
/// and stops it at once) ends that run as soon as it starts. The run clears the request when it
/// ends, so a request made after that ends the next run in the process.
pub fn request_exit() {
    REQUESTED.store(true, Ordering::Relaxed);
}

#[cfg(unix)]
pub(crate) struct Guard(Vec<(libc::c_int, libc::sigaction)>);

#[cfg(unix)]
extern "C" fn request(_: libc::c_int) {
    request_exit();
}

#[cfg(unix)]
impl Guard {
    pub(crate) fn install() -> std::io::Result<Self> {
        let mut guard = Self(Vec::new());
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            // SAFETY: initialized signal actions; the handler only stores an atomic flag.
            unsafe {
                let mut action: libc::sigaction = std::mem::zeroed();
                let mut previous: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = request as *const () as libc::sighandler_t;
                libc::sigemptyset(&mut action.sa_mask);
                if libc::sigaction(signal, &action, &mut previous) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                guard.0.push((signal, previous));
            }
        }
        Ok(guard)
    }
}

#[cfg(unix)]
impl Drop for Guard {
    fn drop(&mut self) {
        for (signal, previous) in &self.0 {
            // SAFETY: restores the action saved when this guard installed its handler.
            unsafe {
                libc::sigaction(*signal, previous, std::ptr::null_mut());
            }
        }
        // The run is over: dropped last, once the terminal is restored. Cleared after the
        // handlers are put back, so a signal on the way out cannot leave a request for the
        // next run.
        REQUESTED.store(false, Ordering::Relaxed);
    }
}

#[cfg(windows)]
pub(crate) struct Guard;
#[cfg(windows)]
unsafe extern "system" fn request(event: u32) -> i32 {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT};
    if matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT) {
        request_exit();
        1
    } else {
        0
    }
}
#[cfg(windows)]
impl Guard {
    pub(crate) fn install() -> std::io::Result<Self> {
        // SAFETY: a static handler that only sets an atomic flag, removed on drop.
        if unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(request), 1) }
            == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self)
    }
}
#[cfg(windows)]
impl Drop for Guard {
    fn drop(&mut self) {
        // SAFETY: unregisters the handler this guard installed.
        unsafe {
            windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(request), 0);
        }
        // The run is over: dropped last, once the terminal is restored. Cleared after the
        // handler is removed, so a Ctrl+C on the way out cannot leave a request for the next
        // run.
        REQUESTED.store(false, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_before_the_run_starts_ends_it_and_the_run_clears_it() {
        request_exit();
        let guard = Guard::install().unwrap();
        assert!(requested(), "installing the guard keeps an earlier request");
        drop(guard);
        assert!(!requested(), "the run ends with no request left");
    }
}
