//! A lifecycle scenario owns a process, session and watchdog, not a libtest thread's terminal state.

use std::{
    fs::{self, File},
    io::{self, IsTerminal, Read},
    os::unix::process::CommandExt,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex, MutexGuard, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

const CASE_TIMEOUT: Duration = Duration::from_secs(45);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);
const SUPERVISOR_GRACE: Duration = Duration::from_secs(5);
const TIMEOUT_EXIT: i32 = 124;
const CLEANUP_FAILED_EXIT: i32 = 125;
const CASE_FILE: &str = ".nsh-lifecycle-case";
const COMPLETE: &str = "lifecycle scenario completed";
const LOG_LIMIT: u64 = 64 * 1024;

static REGISTRY: OnceLock<Arc<Registry>> = OnceLock::new();

pub(super) struct Process {
    child: Mutex<Child>,
    master: Mutex<Option<File>>,
}

impl Process {
    fn new(child: Child, master: Option<File>) -> Arc<Self> {
        Arc::new(Self {
            child: Mutex::new(child),
            master: Mutex::new(master),
        })
    }

    pub(super) fn child(&self) -> MutexGuard<'_, Child> {
        self.child.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn master(&self) -> MutexGuard<'_, Option<File>> {
        self.master
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn close_terminal(&self) {
        let master = self.master().take();
        drop(master);
    }

    pub(super) fn stop(&self) -> bool {
        self.close_terminal();
        {
            let mut child = self.child();
            if matches!(child.try_wait(), Ok(Some(_))) {
                return true;
            }
            let _ = child.kill();
        }
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        loop {
            match self.child().try_wait() {
                Ok(Some(_)) => return true,
                Err(_) => return false,
                Ok(None) if Instant::now() >= deadline => return false,
                Ok(None) => thread::sleep(Duration::from_millis(5)),
            }
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.stop();
    }
}

enum Watch {
    Done,
    Shorten(Duration),
}

struct Registry {
    children: Mutex<Vec<Arc<Process>>>,
    wake: mpsc::Sender<Watch>,
}

impl Registry {
    fn cleanup(&self) -> bool {
        let children = self
            .children
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for child in &children {
            child.close_terminal();
        }
        let mut clean = true;
        for child in &children {
            clean &= child.stop();
        }
        clean
    }
}

struct Watchdog {
    registry: Arc<Registry>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Watchdog {
    fn start() -> Self {
        let (wake, receiver) = mpsc::channel();
        let registry = Arc::new(Registry {
            children: Mutex::new(Vec::new()),
            wake,
        });
        assert!(
            REGISTRY.set(registry.clone()).is_ok(),
            "one scenario per worker process"
        );
        let watched = registry.clone();
        let thread = thread::spawn(move || {
            let mut deadline = Instant::now() + CASE_TIMEOUT;
            loop {
                match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(Watch::Done) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    Ok(Watch::Shorten(timeout)) => {
                        deadline = deadline.min(Instant::now() + timeout)
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let clean = watched.cleanup();
                        eprintln!("lifecycle watchdog expired; children reaped: {clean}");
                        // The scenario thread may be stuck in a syscall or cleanup. End only
                        // this isolated worker, after killing/reaping its registered hosts.
                        std::process::exit(if clean {
                            TIMEOUT_EXIT
                        } else {
                            CLEANUP_FAILED_EXIT
                        });
                    }
                }
            }
        });
        Self {
            registry,
            thread: Some(thread),
        }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        let clean = self.registry.cleanup();
        let _ = self.registry.wake.send(Watch::Done);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        assert!(
            clean || thread::panicking(),
            "could not reap lifecycle children"
        );
    }
}

pub(super) fn track(child: Child, master: File) -> Arc<Process> {
    let process = Process::new(child, Some(master));
    REGISTRY
        .get()
        .expect("host must run in an isolated scenario")
        .children
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(process.clone());
    process
}

pub(super) fn expire_soon() {
    REGISTRY
        .get()
        .unwrap()
        .wake
        .send(Watch::Shorten(Duration::from_millis(100)))
        .unwrap();
}

pub(super) fn fixture() -> std::path::PathBuf {
    assert!(
        REGISTRY.get().is_some(),
        "fixtures belong to isolated scenarios"
    );
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = std::env::current_dir()
        .unwrap()
        .join(format!("host-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir_all(&directory).unwrap();
    directory
}

// Both the worker and each host start a new session. Reset inherited masks and
// ignored job-control/termination signals before exec, without touching the runner.
pub(super) fn new_session() -> io::Result<()> {
    // SAFETY: this function is called only by pre_exec; all operations are async-signal-safe
    // syscalls on stack buffers. No allocation, logging or Rust synchronization occurs here.
    unsafe {
        if libc::setsid() < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut mask = std::mem::zeroed();
        libc::sigemptyset(&mut mask);
        if libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut()) < 0 {
            return Err(io::Error::last_os_error());
        }
        for signal in [
            libc::SIGHUP,
            libc::SIGINT,
            libc::SIGTERM,
            libc::SIGCHLD,
            libc::SIGTSTP,
            libc::SIGTTIN,
            libc::SIGTTOU,
        ] {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = libc::SIG_DFL;
            libc::sigemptyset(&mut action.sa_mask);
            if libc::sigaction(signal, &action, std::ptr::null_mut()) < 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub(super) enum ExpectedExit {
    Success,
    Watchdog,
    Panic,
}

pub(super) fn run(name: &str, expected: ExpectedExit, operation: impl FnOnce()) {
    if fs::read_to_string(CASE_FILE).is_ok_and(|case| case == name) {
        // SAFETY: these are read-only queries of this worker's session and process group.
        unsafe {
            assert_eq!(libc::getsid(0), libc::getpid());
            assert_eq!(libc::getpgrp(), libc::getpid());
        }
        assert!(!io::stdin().is_terminal() && !io::stdout().is_terminal());
        assert!(
            File::open("/dev/tty").is_err(),
            "worker must have no controlling terminal"
        );
        let watchdog = Watchdog::start();
        operation();
        drop(watchdog);
        println!("{COMPLETE}: {name}");
        return;
    }

    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = std::env::temp_dir().join(format!(
        "nsh-tui-case-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&directory).unwrap();
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let directory = Directory(directory);
    fs::write(directory.0.join(CASE_FILE), name).unwrap();
    let log_path = directory.0.join("scenario.log");
    let log = File::create(&log_path).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .current_dir(&directory.0)
        .args([
            "--exact",
            &format!("lifecycle::{name}"),
            "--nocapture",
            "--test-threads=1",
            "--include-ignored",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log));
    // SAFETY: new_session contains only async-signal-safe syscalls.
    unsafe {
        command.pre_exec(new_session);
    }
    let deadline = Instant::now() + CASE_TIMEOUT + SUPERVISOR_GRACE;
    let worker = Process::new(command.spawn().unwrap(), None);
    let status: Option<ExitStatus> = loop {
        if let Some(status) = worker.child().try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            worker.stop();
            break None;
        }
        thread::sleep(Duration::from_millis(5));
    };
    let mut log = Vec::new();
    File::open(log_path)
        .unwrap()
        .take(LOG_LIMIT)
        .read_to_end(&mut log)
        .unwrap();
    let log = String::from_utf8_lossy(&log);
    let status = status
        .unwrap_or_else(|| panic!("lifecycle scenario {name} exceeded its hard deadline:\n{log}"));
    if matches!(expected, ExpectedExit::Watchdog | ExpectedExit::Panic) {
        match expected {
            ExpectedExit::Watchdog => assert_eq!(status.code(), Some(TIMEOUT_EXIT), "{log}"),
            ExpectedExit::Panic => assert!(
                !status.success() && log.contains("intentional lifecycle failure"),
                "{log}"
            ),
            ExpectedExit::Success => unreachable!(),
        }
        let pid: libc::pid_t = fs::read_to_string(directory.0.join("host.pid"))
            .unwrap()
            .parse()
            .unwrap();
        // SAFETY: signal zero only queries existence; it cannot affect another process.
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "watchdog left the blocked host alive"
        );
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    } else {
        assert!(
            status.success() && log.contains(&format!("{COMPLETE}: {name}")),
            "lifecycle scenario {name}: {status}\n{log}"
        );
        print!("{log}");
    }
}
