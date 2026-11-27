//! Local development-session ownership. The OS lock lasts for the whole
//! command, including Rust rebuilds and host cleanup. A stop file asks the
//! owner to unwind normally; no PID is trusted and no process is killed.
//! Lock files stay in place so all contenders always lock the same inode.
//!
//! Without `--port`, a command takes the port its app had last, replacing the
//! app's previous session there, else the first free one from the default.
//! Each port's `.app` file names the app that had it.
//!
//! A running session keeps its token for `nsh test --attach` in its port's
//! `.attach` file ([`AttachFile`]), readable by its user only: what lets
//! that command, and nothing else on the machine, drive its hosts.

use std::{
    fs::{self, File, TryLockError},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use anyhow::{Context as _, bail};
use nsh_dev::protocol::DEFAULT_PORT;

static STOP: Mutex<Option<PathBuf>> = Mutex::new(None);
const WAIT: Duration = Duration::from_secs(10);
/// How many ports from the default a command tries.
const PORTS: u16 = 100;

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
    /// Owns `port`, replacing the NSH session on it.
    pub(crate) fn acquire(port: u16, app: &Path) -> anyhow::Result<Option<Self>> {
        // Port zero explicitly asks the OS to allocate a free port.
        if port == 0 {
            return Ok(None);
        }
        let dir = crate::check::cache()?.join("dev-sessions");
        let (session, stop) = Self::in_dir(&dir, port, WAIT)?;
        Ok(Some(session.owned(&dir, port, &identity(app), stop)?))
    }

    /// Owns the port of `app`'s last session or the first one free at `host`,
    /// the address the dev server will listen on, returning it. With every
    /// port in the range taken, the OS allocates one.
    pub(crate) fn acquire_free(app: &Path, host: Ipv4Addr) -> anyhow::Result<(Option<Self>, u16)> {
        listenable(host)?;
        let dir = crate::check::cache()?.join("dev-sessions");
        let app = &identity(app);
        let is_free = |port| port_is_free(host, port);
        match Self::free_in_dir(&dir, DEFAULT_PORT, app, WAIT, is_free)? {
            Some((session, port, stop)) => Ok((Some(session.owned(&dir, port, app, stop)?), port)),
            None => Ok((None, 0)),
        }
    }

    fn owned(self, dir: &Path, port: u16, app: &Path, stop: PathBuf) -> anyhow::Result<Self> {
        fs::write(app_file(dir, port), app.as_os_str().as_encoded_bytes())
            .context("record the development session's app")?;
        *STOP.lock().expect("dev port lock") = Some(stop);
        Ok(self)
    }

    fn free_in_dir(
        dir: &Path,
        first: u16,
        app: &Path,
        timeout: Duration,
        is_free: impl Fn(u16) -> bool,
    ) -> anyhow::Result<Option<(Self, u16, PathBuf)>> {
        fs::create_dir_all(dir).context("create development session directory")?;
        let ports = || first..first.saturating_add(PORTS);
        // A session of this app goes first, even one still running: it is
        // what this command replaces, and hosts keep their address.
        for port in ports() {
            let had = fs::read(app_file(dir, port))
                .is_ok_and(|had| had == app.as_os_str().as_encoded_bytes());
            if had {
                let (session, stop) = Self::in_dir(dir, port, timeout)?;
                if is_free(port) {
                    return Ok(Some((session, port, stop)));
                }
            }
        }
        for port in ports() {
            // A port held by a session, or being taken over, is another
            // app's: skip it, never ask it to stop.
            let takeover = open(&dir.join(format!("{port}.takeover")))?;
            if !lock(&takeover)? {
                continue;
            }
            let owner = open(&dir.join(format!("{port}.lock")))?;
            if !lock(&owner)? || !is_free(port) {
                continue;
            }
            let stop = dir.join(format!("{port}.stop"));
            clear_stop(&stop)?;
            return Ok(Some((Self { _owner: owner }, port, stop)));
        }
        Ok(None)
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
        clear_stop(&stop)?;
        Ok((Self { _owner: owner }, stop))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        *STOP.lock().expect("dev port lock") = None;
    }
}

fn clear_stop(stop: &Path) -> anyhow::Result<()> {
    match fs::remove_file(stop) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).context("clear development session stop request"),
    }
}

/// The app as recorded in `<port>.app`: its absolute entry path, so the same
/// relative entry in two directories (two checkouts) names two apps.
fn identity(app: &Path) -> PathBuf {
    fs::canonicalize(app)
        .or_else(|_| std::path::absolute(app))
        .unwrap_or_else(|_| app.to_path_buf())
}

fn app_file(dir: &Path, port: u16) -> PathBuf {
    dir.join(format!("{port}.app"))
}

fn attach_file(dir: &Path, port: u16) -> PathBuf {
    dir.join(format!("{port}.attach"))
}

/// A running session's token for `nsh test --attach`, kept in its port's
/// `.attach` file while the session runs (removed when dropped, unless a
/// later session on the port wrote its own).
pub(crate) struct AttachFile {
    path: PathBuf,
    token: String,
}

impl AttachFile {
    /// Makes a token for the session on `port` and writes it where `nsh
    /// test --attach` finds it, readable by this user only.
    pub(crate) fn new(port: u16) -> anyhow::Result<Self> {
        let dir = crate::check::cache()?.join("dev-sessions");
        fs::create_dir_all(&dir).context("create development session directory")?;
        let mut bytes = [0u8; 32];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
            .map_err(|_| anyhow::anyhow!("make the development session's token"))?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let path = attach_file(&dir, port);
        write_private(&path, token.as_bytes())
            .context("record the development session's token for nsh test --attach")?;
        Ok(AttachFile { path, token })
    }

    /// The token.
    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for AttachFile {
    fn drop(&mut self) {
        if fs::read(&self.path).is_ok_and(|kept| kept == self.token.as_bytes()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Writes `bytes` to `path`, which only this user may read (a new file's
/// mode on Unix; the user's own cache directory elsewhere).
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let _ = fs::remove_file(path);
    let mut options = File::options();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(path)?, bytes)
}

/// A development session `nsh test --attach` may drive, as its files say:
/// it may have ended since.
pub(crate) struct AttachableSession {
    pub(crate) port: u16,
    pub(crate) token: String,
    /// Its app's entry (`None`: a session on a port the OS chose).
    pub(crate) app: Option<PathBuf>,
}

/// The development sessions on this machine `nsh test --attach` may drive,
/// by port; on `port` only, when given.
pub(crate) fn attachable_sessions(port: Option<u16>) -> anyhow::Result<Vec<AttachableSession>> {
    let dir = crate::check::cache()?.join("dev-sessions");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut sessions: Vec<AttachableSession> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let port: u16 = name.to_str()?.strip_suffix(".attach")?.parse().ok()?;
            let token = fs::read_to_string(entry.path()).ok()?;
            let app = fs::read(app_file(&dir, port))
                .ok()
                .map(|bytes| PathBuf::from(String::from_utf8_lossy(&bytes).into_owned()));
            Some(AttachableSession {
                port,
                token: token.trim().to_owned(),
                app,
            })
        })
        .filter(|session| port.is_none_or(|p| p == session.port))
        .collect();
    sessions.sort_by_key(|session| session.port);
    Ok(sessions)
}

/// Whether `entry` is the app a session's `.app` file names.
pub(crate) fn is_app(recorded: &Path, entry: &Path) -> bool {
    recorded == identity(entry)
}

/// Fails for an address this machine cannot listen at (a mistyped `--host`),
/// which fails at every port alike: the probe of each would say it is taken,
/// and the server would fall back to the OS's port and fail there.
fn listenable(host: Ipv4Addr) -> anyhow::Result<()> {
    std::net::TcpListener::bind((host, 0))
        .map(drop)
        .with_context(|| format!("the dev server cannot listen at {host}"))
}

/// Whether a dev server could listen on `port` at `host`, the address it
/// will listen on. Listening on every interface for a server that will
/// listen on loopback only, even briefly, makes Windows Defender Firewall
/// ask the user to let each new `nsh` executable on the network.
fn port_is_free(host: Ipv4Addr, port: u16) -> bool {
    std::net::TcpListener::bind((host, port)).is_ok()
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

    /// A port is probed at the address the server will listen on: a local
    /// server's is loopback, so the probe never listens on every interface.
    #[test]
    fn a_port_is_free_at_the_address_the_server_listens_on() {
        let held = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(!port_is_free(Ipv4Addr::LOCALHOST, port));
        drop(held);
        assert!(port_is_free(Ipv4Addr::LOCALHOST, port));
    }

    /// An address no machine has (TEST-NET-1) is refused before any port is
    /// probed; loopback is not.
    #[test]
    fn an_address_this_machine_lacks_is_refused_at_once() {
        let err = listenable(Ipv4Addr::new(192, 0, 2, 1)).unwrap_err();
        assert!(
            err.to_string().contains("cannot listen at 192.0.2.1"),
            "{err}"
        );
        listenable(Ipv4Addr::LOCALHOST).unwrap();
    }

    #[test]
    fn a_free_port_skips_other_apps_and_returns_to_the_apps_own() {
        let dir = Directory::new();
        let (a, b) = (Path::new("/apps/a"), Path::new("/apps/b"));
        let take = |app: &Path, is_free: fn(u16) -> bool| {
            let (session, port, stop) = Session::free_in_dir(&dir.0, 8790, app, WAIT, is_free)
                .unwrap()
                .unwrap();
            fs::write(app_file(&dir.0, port), app.as_os_str().as_encoded_bytes()).unwrap();
            (session, port, stop)
        };
        let (first, port, stop) = take(a, |_| true);
        assert_eq!(port, 8790);
        // Another app moves on, leaving the first session alone.
        let (second, port, _) = take(b, |_| true);
        assert_eq!(port, 8791);
        assert!(!stop.exists());
        // Something other than NSH holds a port.
        drop(second);
        let (second, port, _) = take(b, |port| port != 8791);
        assert_eq!(port, 8792);
        drop(second);

        // The same app replaces its session, on the same port.
        let path = dir.0.clone();
        let replacing = std::thread::spawn(move || {
            Session::free_in_dir(&path, 8790, Path::new("/apps/a"), WAIT, |_| true)
                .unwrap()
                .unwrap()
                .1
        });
        while !stop.exists() {
            std::thread::sleep(Duration::from_millis(5));
        }
        drop(first);
        assert_eq!(replacing.join().unwrap(), 8790);
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
    fn the_same_relative_entry_in_two_directories_is_two_apps() {
        let dir = Directory::new();
        let (a, b) = (dir.0.join("a"), dir.0.join("b"));
        for d in [&a, &b] {
            fs::create_dir_all(d).unwrap();
            fs::write(d.join("App.tsx"), "").unwrap();
        }
        let (ia, ib) = (identity(&a.join("App.tsx")), identity(&b.join("App.tsx")));
        assert!(ia.is_absolute());
        assert_ne!(ia, ib);
        // A relative path and its absolute form are one app.
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            identity(Path::new("Cargo.toml")),
            identity(&cwd.join("Cargo.toml"))
        );
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
