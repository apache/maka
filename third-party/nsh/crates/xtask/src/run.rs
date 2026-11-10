//! `cargo run` (the workspace's default task): runs an example app, the
//! gallery by default, on the machine's own desktop backend (the AppKit
//! host on macOS, the GTK host on Linux, the Win32 host on Windows; an
//! Android device or emulator elsewhere) with hot reload (`nsh run`), and rebuilds and restarts it when the runtime's sources
//! under `crates/` change: components and modules are Rust and live in the
//! host, so only JS and TSX reload in place.

use std::{
    path::Path,
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use anyhow::Context as _;
use clap::Args;
use notify::{EventKind, RecursiveMode, Watcher as _};

use crate::{android, term};

/// Options of `cargo run`, passed on to `nsh run`.
#[derive(Args)]
pub(crate) struct RunArgs {
    /// The app: its directory (whose `App.tsx` is the entry) or its entry
    /// module; else a demo of the gallery, by its name (any case), which
    /// the gallery opens at (`cargo run -- accordion`, as GPUI Kit's story).
    #[arg(default_value = "examples/gallery")]
    entry: String,
    /// With a demo of the gallery: show only its section with this title
    /// (`--section settings`, any case).
    #[arg(long)]
    section: Option<String>,
    /// Where to run: `macos` (the AppKit host), `catalyst`, `ios` (a
    /// simulator), `android`, `linux`, `windows` or `gpui` (the GPUI host);
    /// default: the machine's own backend (`macos` on macOS, `linux` on
    /// Linux, `windows` on Windows), else `android`.
    #[arg(long)]
    target: Option<String>,
    /// iOS simulator to use (name or UDID).
    #[arg(long)]
    device: Option<String>,
    /// Log per-commit timings.
    #[arg(long)]
    trace: bool,
}

/// Set by SIGINT / SIGTERM: the app runs in its own process group (so a
/// restart can stop `nsh run` and the host it launched together), which
/// does not see the terminal's Ctrl-C.
static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

pub(crate) fn run(args: RunArgs) -> anyhow::Result<()> {
    let root = android::root();
    // SAFETY: the handler only stores to an atomic, which is
    // async-signal-safe.
    unsafe {
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
    }
    let (tx, changes) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event
            && !matches!(event.kind, EventKind::Access(_))
            && event.paths.iter().any(|p| is_source(p))
        {
            let _ = tx.send(());
        }
    })?;
    // Canonical: inotify reports paths under the one watched as given, and
    // `root`'s `..` would make every one look like a dot entry.
    let crates = root.join("crates");
    watcher.watch(
        &crates.canonicalize().unwrap_or(crates),
        RecursiveMode::Recursive,
    )?;
    loop {
        let mut app = match build_cli(&root) {
            Ok(()) => Some(launch(&root, &args)?),
            // Ctrl-C stopped the build too.
            Err(_) if STOP.load(Ordering::SeqCst) => return Ok(()),
            Err(err) => {
                term::report(&err);
                term::note("waiting for changes under crates/");
                None
            }
        };
        // Until a source changes, the app exits or the user stops us.
        loop {
            if STOP.load(Ordering::SeqCst) {
                if let Some(app) = app.as_mut() {
                    stop(app);
                }
                return Ok(());
            }
            if let Some(app) = app.as_mut()
                && let Some(status) = app.child.try_wait()?
            {
                // The host window was closed.
                std::process::exit(status.code().unwrap_or(1));
            }
            match changes.recv_timeout(Duration::from_millis(100)) {
                Ok(()) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
        // Editors save several files at once: take them as one change.
        while changes.recv_timeout(Duration::from_millis(300)).is_ok() {}
        if let Some(app) = app.as_mut() {
            stop(app);
        }
        term::note("crates/ changed: rebuilding and restarting");
    }
}

/// Whether a changed path is a source of the runtime (not build output,
/// generated types or editor state).
fn is_source(path: &Path) -> bool {
    !path.components().any(|c| {
        let c = c.as_os_str().to_string_lossy();
        c == "target" || c.starts_with('.')
    }) && !path.to_string_lossy().ends_with('~')
}

fn build_cli(root: &Path) -> anyhow::Result<()> {
    term::cargo(
        Command::new("cargo")
            .args(["build", "-p", "nsh-cli"])
            .current_dir(root),
        "nsh",
    )
}

/// `nsh run`, started by [`launch`].
struct App {
    child: Child,
    /// Ends `nsh run` and the host with xtask, however xtask ends.
    #[cfg(windows)]
    _job: Option<win::Job>,
}

/// Starts `nsh run`, which builds the host it needs, in a process group of
/// its own.
fn launch(root: &Path, args: &RunArgs) -> anyhow::Result<App> {
    let nsh = format!("target/debug/nsh{}", std::env::consts::EXE_SUFFIX);
    let mut cmd = Command::new(root.join(&nsh));
    // Not an app: a demo of the gallery, which reads where to open from
    // the environment its host inherits (`examples/gallery/App.tsx`).
    let entry = if root.join(&args.entry).exists() {
        args.entry.as_str()
    } else {
        cmd.env("NSH_GALLERY_DEMO", &args.entry);
        "examples/gallery"
    };
    if let Some(section) = &args.section {
        cmd.env("NSH_GALLERY_SECTION", section);
    }
    cmd.arg("run").arg(entry).current_dir(root);
    let default = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(windows) {
        "windows"
    } else {
        "android"
    };
    cmd.args(["--target", args.target.as_deref().unwrap_or(default)]);
    if let Some(device) = &args.device {
        cmd.args(["--device", device]);
    }
    if args.trace {
        cmd.arg("--trace");
    }
    if term::verbose() {
        cmd.arg("--verbose");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP);
    }
    let child = cmd.spawn().with_context(|| format!("launch {nsh}"))?;
    Ok(App {
        #[cfg(windows)]
        _job: win::Job::assign(&child),
        child,
    })
}

/// Stops `nsh run` and everything it started (the Catalyst, macOS or Linux
/// host).
#[cfg(unix)]
fn stop(app: &mut App) {
    let app = &mut app.child;
    let Ok(pgid) = libc::pid_t::try_from(app.id()) else {
        let _ = app.kill();
        return;
    };
    // SAFETY: plain syscalls on the process group `launch` created.
    unsafe { libc::killpg(pgid, libc::SIGTERM) };
    for _ in 0..30 {
        if matches!(app.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // SAFETY: as above.
    unsafe { libc::killpg(pgid, libc::SIGKILL) };
    let _ = app.wait();
}

/// Stops `nsh run` and everything it started: Ctrl-Break to its process
/// group (`nsh` takes it as Ctrl-C, and stops its host), then the job.
#[cfg(windows)]
fn stop(app: &mut App) {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent};

    // SAFETY: a plain call naming the process group `launch` created.
    unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, app.child.id()) };
    for _ in 0..30 {
        if matches!(app.child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // Closing the job ends whatever is left of it.
    app._job = None;
    let _ = app.child.kill();
    let _ = app.child.wait();
}

/// Windows ends a child process with its parent only in a job.
#[cfg(windows)]
mod win {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
    };

    /// A job object that ends its processes when it closes.
    pub(super) struct Job(HANDLE);

    impl Job {
        /// Puts `child` in a new job; `None` if Windows refuses.
        pub(super) fn assign(child: &std::process::Child) -> Option<Job> {
            use std::os::windows::io::AsRawHandle as _;

            // SAFETY: an unnamed job with default security, owned (and
            // closed) by the returned value.
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return None;
            }
            let job = Job(job);
            // SAFETY: zeroed is a valid "no limits" value of this plain C
            // structure.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `info` is the structure the information class names,
            // with its size; `child`'s handle is open while it is borrowed.
            let ok = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&raw const info).cast(),
                    std::mem::size_of_val(&info) as u32,
                ) != 0
                    && AssignProcessToJobObject(job.0, child.as_raw_handle()) != 0
            };
            ok.then_some(job)
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle this value owns, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }
}
