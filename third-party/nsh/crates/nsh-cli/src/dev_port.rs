//! Local development-session ownership. The OS lock lasts for the whole
//! command, including Rust rebuilds and host cleanup. A stop file asks the
//! owner to unwind normally; no PID is trusted and no process is killed.
//! Lock files stay in place so all contenders always lock the same inode.

use std::{
    fs::{self, File, TryLockError},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use anyhow::{Context as _, bail};

static STOP: Mutex<Option<PathBuf>> = Mutex::new(None);
const WAIT: Duration = Duration::from_secs(10);

pub(crate) fn stop_requested() -> bool {
    STOP.lock()
        .expect("dev port lock")
        .as_ref()
        .is_some_and(|p| p.exists())
}

pub(crate) struct Session {
    // Dropped only after the command's hosts, server and forwarding rules.
    _owner: File,
}

impl Session {
    pub(crate) fn acquire(port: u16) -> anyhow::Result<Option<Self>> {
        // Port zero explicitly asks the OS to allocate a free port.
        if port == 0 {
            return Ok(None);
        }
        let dir = crate::check::cache()?.join("dev-sessions");
        let (session, stop) = Self::in_dir(&dir, port, WAIT)?;
        *STOP.lock().expect("dev port lock") = Some(stop);
        Ok(Some(session))
    }

    fn in_dir(dir: &Path, port: u16, timeout: Duration) -> anyhow::Result<(Self, PathBuf)> {
        fs::create_dir_all(dir).context("create development session directory")?;
        // Only one replacement may wait for cleanup. A competing startup
        // fails instead of clearing another contender's stop request.
        let takeover = open(&dir.join(format!("{port}.takeover")))?;
        if !lock(&takeover)? {
            bail!("another NSH session is already taking over port {port}");
        }
        let owner = open(&dir.join(format!("{port}.lock")))?;
        let stop = dir.join(format!("{port}.stop"));
        if !lock(&owner)? {
            crate::ui::note(format!(
                "replacing the NSH development session on port {port}"
            ));
            fs::write(&stop, b"stop\n").context("request the previous NSH session to stop")?;
            let deadline = Instant::now() + timeout;
            loop {
                if lock(&owner)? {
                    break;
                }
                if Instant::now() >= deadline {
                    bail!(
                        "timed out waiting for the NSH session on port {port} to finish cleanup; stop it or choose another --port"
                    );
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        // A crash or timed-out replacement may have left a stop request.
        // Only the new owner, under both locks, can clear it.
        match fs::remove_file(&stop) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).context("clear development session stop request"),
        }
        Ok((Self { _owner: owner }, stop))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        *STOP.lock().expect("dev port lock") = None;
    }
}

fn open(path: &Path) -> anyhow::Result<File> {
    File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .with_context(|| format!("open development session lock {}", path.display()))
}

fn lock(file: &File) -> anyhow::Result<bool> {
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(e)) => Err(e).context("lock development session"),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            Self(std::env::temp_dir().join(format!(
                "nsh-dev-port-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn replacement_waits_for_cleanup_and_rejects_another_contender() {
        let dir = Directory::new();
        let (old, stop) = Session::in_dir(&dir.0, 8790, WAIT).unwrap();
        let path = dir.0.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let replacement = Session::in_dir(&path, 8790, WAIT).unwrap();
            tx.send(()).unwrap();
            replacement
        });
        let deadline = Instant::now() + WAIT;
        while !stop.exists() {
            assert!(Instant::now() < deadline, "no stop request");
            std::thread::sleep(Duration::from_millis(10));
        }
        // Merely requesting a stop never lets the next command start.
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        let error = Session::in_dir(&dir.0, 8790, WAIT).err().unwrap();
        assert!(error.to_string().contains("already taking over port 8790"));
        // Model host / forwarding cleanup happening after the server stops.
        fs::write(dir.0.join("cleaned"), "done").unwrap();
        drop(old);
        rx.recv_timeout(WAIT).unwrap();
        let (new, _) = worker.join().unwrap();
        assert!(dir.0.join("cleaned").exists());
        assert!(!stop.exists());
        drop(new);
    }

    #[test]
    fn timeout_preserves_owner_and_next_owner_clears_stale_request() {
        let dir = Directory::new();
        let (old, stop) = Session::in_dir(&dir.0, 8790, WAIT).unwrap();
        let error = Session::in_dir(&dir.0, 8790, Duration::ZERO).err().unwrap();
        assert!(error.to_string().contains("timed out"));
        assert!(stop.exists());
        assert!(!lock(&open(&dir.0.join("8790.lock")).unwrap()).unwrap());
        // OS ownership is released even when the stop file survives.
        drop(old);
        let (new, _) = Session::in_dir(&dir.0, 8790, WAIT).unwrap();
        assert!(!stop.exists());
        drop(new);
    }

    #[test]
    fn different_ports_run_independently() {
        let dir = Directory::new();
        let (first, stop) = Session::in_dir(&dir.0, 8790, WAIT).unwrap();
        let (second, _) = Session::in_dir(&dir.0, 8791, WAIT).unwrap();
        assert!(!stop.exists());
        drop((first, second));
    }
}
