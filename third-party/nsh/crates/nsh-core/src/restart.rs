//! Starting a standalone desktop app again (`Application.restart()`,
//! [`crate::element::desktop::restart`]), what the desktop runners share.
//! Runner plumbing, not app API: apps call `restart()`, and the module is
//! hidden from the documentation.
//!
//! A runner quits as for `Application.quit()` and, when its run has ended,
//! calls [`spawn_after_exit`]. The new process starts only once this one has
//! exited, so the two never run side by side: files the old one writes as
//! it ends, locks it holds and a Dock or taskbar entry are its own until it
//! is gone. On macOS and Linux a small shell waits for this process and then
//! starts the program (inside an `.app` bundle through Launch Services,
//! `open -n`, so the app comes up as when the user opens it). Windows has
//! no shell to wait with: the program starts at once with
//! [`WAIT_FOR_ENV`] naming this process, and the runner of the new one waits
//! for it ([`wait_for_pid`]) before it opens its window.

use std::{
    ffi::OsString,
    io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};

/// The program a restart starts, when it was taken before the app on disk
/// changed ([`remember_program`]).
static PROGRAM: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Takes the running program's path for a later restart, before something
/// replaces the app on disk (an update swapping its directory or `.app`).
/// Afterwards the process' own executable is the one moved aside and
/// deleted: Linux then reports `<old path> (deleted)` and macOS the moved
/// bundle, and starting either would fail or run what is gone.
pub fn remember_program() {
    if let Ok(exe) = std::env::current_exe() {
        *PROGRAM.lock().unwrap_or_else(|e| e.into_inner()) = Some(exe);
    }
}

/// Sets the program a restart starts: an update's new executable, when the
/// update renamed it or its `.app`.
#[cfg(all(
    feature = "updater",
    any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        windows
    )
))]
pub(crate) fn set_program(path: PathBuf) {
    *PROGRAM.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
}

/// The program the app runs from: the one [`remember_program`] took before
/// something replaced the app on disk, else this process' executable. What
/// a restart starts, and what the desktops' login items start at login.
pub fn program_path() -> io::Result<PathBuf> {
    match PROGRAM.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        Some(exe) => Ok(exe),
        None => std::env::current_exe(),
    }
}

/// What runs once the app's run has ended ([`run_at_exit`]): an update
/// waiting to replace the app as it quits (`installOnQuit`). One per
/// process, as the program on disk is one per process.
static AT_EXIT: Mutex<Option<Box<dyn FnOnce() + Send>>> = Mutex::new(None);

/// Sets what runs once the app's run has ended, replacing (and dropping)
/// what was set before; `None` clears it. Only `nsh/updater` sets any, on
/// the desktops.
#[cfg(all(
    feature = "updater",
    any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        windows
    )
))]
pub(crate) fn set_at_exit(work: Option<Box<dyn FnOnce() + Send>>) {
    let previous = std::mem::replace(
        &mut *AT_EXIT.lock().unwrap_or_else(|e| e.into_inner()),
        work,
    );
    drop(previous);
}

/// Runs what the app left to do as it quits (an update to install,
/// `installOnQuit`). Called by a runner when its run has ended, the
/// windows closed and storage written, before it starts the app again
/// ([`spawn_after_exit`]) so that a restart starts the new version. Blocks
/// for as long as the work takes; it reports its own failures, so the app
/// still exits.
pub fn run_at_exit() {
    let work = AT_EXIT.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(work) = work {
        work();
    }
}

/// The environment variable that names the process a restarted app
/// replaces (its id, in decimal). Set by [`spawn_after_exit`] on Windows;
/// the runner of the new process takes it ([`wait_for_pid`]) and waits for
/// that process to exit before it opens its window.
pub const WAIT_FOR_ENV: &str = "NSH_RESTART_AFTER";

/// How long a restarted app waits at most for the process it replaces: a
/// process that hangs while it exits must not keep the new one from coming
/// up.
pub const WAIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Starts this program again, with the arguments it was started with, once
/// this process has exited. Called by a runner when its run has ended
/// because the app asked to restart; the new process inherits the
/// environment and the working directory.
pub fn spawn_after_exit() -> io::Result<()> {
    let exe = program_path()?;
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let mut command = command(&exe, &args, std::process::id());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Out of the terminal's process group: a Ctrl+C meant for the old
        // process does not stop the wait.
        command.process_group(0);
    }
    command.spawn().map(drop)
}

/// The command that starts `exe` with `args` again once process `pid` has
/// exited.
#[cfg(unix)]
fn command(exe: &Path, args: &[OsString], pid: u32) -> Command {
    // `$0` is the process to wait for, `"$@"` the program and its
    // arguments. `kill -0` fails once it is gone; at most `WAIT_LIMIT`.
    let tries = WAIT_LIMIT.as_millis() / 100;
    let script = format!(
        "i=0; while kill -0 \"$0\" 2>/dev/null && [ $i -lt {tries} ]; do sleep 0.1; i=$((i+1)); done; exec \"$@\""
    );
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(script)
        .arg(pid.to_string())
        .args(program(exe, args));
    command
}

/// The command that starts `exe` with `args` at once, naming process `pid`
/// for the new process' runner to wait for.
#[cfg(not(unix))]
fn command(exe: &Path, args: &[OsString], pid: u32) -> Command {
    let mut command = Command::new(exe);
    command.args(args).env(WAIT_FOR_ENV, pid.to_string());
    command
}

/// The program and arguments that start `exe` with `args`: inside an
/// `.app` bundle on macOS a new instance of the bundle through Launch
/// Services (`open -n`), which activates it and gives it its Dock icon as
/// opening it from the Finder does; elsewhere `exe` itself.
#[cfg(unix)]
fn program(exe: &Path, args: &[OsString]) -> Vec<OsString> {
    if cfg!(target_os = "macos")
        && let Some(bundle) = app_bundle(exe)
    {
        let mut program: Vec<OsString> = vec!["/usr/bin/open".into(), "-n".into(), bundle.into()];
        if !args.is_empty() {
            program.push("--args".into());
            program.extend(args.iter().cloned());
        }
        return program;
    }
    std::iter::once(exe.as_os_str().to_owned())
        .chain(args.iter().cloned())
        .collect()
}

/// The `.app` bundle whose main executable `exe` is
/// (`<name>.app/Contents/MacOS/<exe>`).
#[cfg(unix)]
fn app_bundle(exe: &Path) -> Option<&Path> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then_some(bundle)
}

/// The process this one replaces, when it was started by
/// [`spawn_after_exit`] ([`WAIT_FOR_ENV`]), for its runner to wait for. The
/// variable is read only: the runner removes it so that programs the app
/// starts do not inherit it.
pub fn wait_for_pid() -> Option<u32> {
    std::env::var(WAIT_FOR_ENV).ok()?.trim().parse().ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_remembered_program_is_started_again() {
        remember_program();
        assert_eq!(program_path().unwrap(), std::env::current_exe().unwrap());
    }

    fn strings(program: Vec<OsString>) -> Vec<String> {
        program
            .into_iter()
            .map(|s| s.into_string().unwrap())
            .collect()
    }

    #[test]
    fn a_bundle_is_found_from_its_main_executable_only() {
        assert_eq!(
            app_bundle(Path::new("/Applications/WTT.app/Contents/MacOS/wtt")),
            Some(Path::new("/Applications/WTT.app"))
        );
        assert_eq!(app_bundle(Path::new("/usr/local/bin/wtt")), None);
        assert_eq!(
            app_bundle(Path::new("/Applications/WTT.app/Contents/Resources/wtt")),
            None
        );
    }

    #[test]
    fn the_program_starts_again_with_its_arguments() {
        let args = [OsString::from("--lang"), OsString::from("en")];
        let exe = Path::new("/Applications/WTT.app/Contents/MacOS/wtt");
        let program = strings(program(exe, &args));
        if cfg!(target_os = "macos") {
            assert_eq!(
                program,
                [
                    "/usr/bin/open",
                    "-n",
                    "/Applications/WTT.app",
                    "--args",
                    "--lang",
                    "en"
                ]
            );
            assert_eq!(
                strings(super::program(exe, &[])),
                ["/usr/bin/open", "-n", "/Applications/WTT.app"]
            );
        } else {
            assert_eq!(program, [exe.to_str().unwrap(), "--lang", "en"]);
        }
        assert_eq!(
            strings(super::program(Path::new("/opt/app/run"), &args)),
            ["/opt/app/run", "--lang", "en"]
        );
    }

    /// The new process starts only after the one it replaces has exited.
    #[test]
    fn the_program_starts_after_the_old_process_exits() {
        let dir = std::env::temp_dir().join(format!("nsh-restart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("started");
        let _ = std::fs::remove_file(&marker);
        // The "old process": alive for a moment.
        let mut old = Command::new("/bin/sh")
            .args(["-c", "sleep 0.5"])
            .spawn()
            .unwrap();
        let mut waiter = command(
            Path::new("/bin/sh"),
            &["-c".into(), format!("touch '{}'", marker.display()).into()],
            old.id(),
        )
        .spawn()
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!marker.exists(), "started while the old process runs");
        old.wait().unwrap();
        assert!(waiter.wait().unwrap().success());
        assert!(marker.exists(), "not started after the old process exited");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// What runs at exit runs once, the latest set; what it replaced is
    /// dropped unrun.
    #[cfg(all(
        feature = "updater",
        any(
            all(target_os = "linux", not(target_env = "ohos")),
            target_os = "macos",
            windows
        )
    ))]
    #[test]
    fn the_latest_work_runs_once_at_exit() {
        use std::sync::{
            Arc,
            atomic::{AtomicU32, Ordering},
        };
        let ran = Arc::new(AtomicU32::new(0));
        let dropped = Arc::new(AtomicU32::new(0));
        struct Dropped(Arc<AtomicU32>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let first = Dropped(dropped.clone());
        let ran_first = ran.clone();
        set_at_exit(Some(Box::new(move || {
            let _first = first;
            ran_first.fetch_add(10, Ordering::SeqCst);
        })));
        let ran_second = ran.clone();
        set_at_exit(Some(Box::new(move || {
            ran_second.fetch_add(1, Ordering::SeqCst);
        })));
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        run_at_exit();
        run_at_exit();
        assert_eq!(ran.load(Ordering::SeqCst), 1);
        set_at_exit(Some(Box::new(|| panic!("cleared"))));
        set_at_exit(None);
        run_at_exit();
    }
}
