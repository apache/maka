//! `nsh test --target`: the apps tests open run on a real platform's
//! development host instead of a headless engine. Each `open` builds the
//! entry, starts a dev server of its own in a test session
//! (`DevServer::test_session`) serving that build, and starts the host on
//! it; the host's test agent (`nsh_testing::agent`) takes the test's steps
//! at the views the selectors name, with the platform's own input. The
//! host goes when the test closes the app. The web's host is a page in a
//! headless browser, whose agent runs in this process (`test_web.rs`).

use std::{
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_dev::{
    AppInfo, ClientEvent, DevServer,
    protocol::{LogLevel, WS_PATH},
};
use nsh_testing::{Host, HostOptions, StartHost};

use crate::{build, run::Target, ui};

/// How long a host may take to start and connect.
const CONNECT: Duration = Duration::from_secs(60);

/// Starts the apps tests open on `target`'s host; `browser` is the one
/// `--target web` runs them in (else the one found on this machine); `fps`
/// has the host log its performance monitor's readings; `display` (one-based)
/// is the display the macOS host opens its windows on (by default a
/// secondary one when there is one).
pub(crate) fn starter(
    target: Target,
    browser: Option<&Path>,
    work: &Path,
    fps: bool,
    display: Option<usize>,
) -> anyhow::Result<StartHost> {
    if browser.is_some() && target != Target::Web {
        anyhow::bail!("--browser goes with --target web");
    }
    if fps
        && !matches!(
            target,
            Target::Linux | Target::Macos | Target::Windows | Target::Ios
        )
    {
        anyhow::bail!("--fps goes with --target linux, macos, windows or ios");
    }
    if display.is_some() && target != Target::Macos {
        anyhow::bail!("--display goes with --target macos");
    }
    match target {
        Target::Web => return crate::test_web::starter(browser),
        Target::Ios => return crate::test_ios::starter(work, fps),
        Target::Android => return crate::test_android::starter(work),
        _ => {}
    }
    if !matches!(
        target,
        Target::Macos | Target::Linux | Target::Windows | Target::Gpui
    ) {
        anyhow::bail!("nsh test --target takes macos, linux, windows, gpui, web, ios or android");
    }
    // Built (in a checkout) or found once, before the first test.
    let host = crate::runtime::test_host(target.platform())?;
    Ok(Arc::new(move |entry: &Path, options: &HostOptions| {
        start(target, &host, entry, options, fps, display).map(|h| Box::new(h) as Box<dyn Host>)
    }))
}

/// A host running one app for a test.
struct TestHost {
    server: DevServer,
    child: Child,
    /// The app's data directory, fresh for it and removed after it.
    data: std::path::PathBuf,
}

impl Host for TestHost {
    fn step(
        &self,
        step: nsh_dev::protocol::TestStep,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        self.server.step(step, timeout)
    }
}

impl Drop for TestHost {
    fn drop(&mut self) {
        // It quits after the test's `Quit`; a host that does not goes.
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

/// Builds `entry`, serves it in a test session and starts `host` on it.
fn start(
    target: Target,
    host: &Path,
    entry: &Path,
    options: &HostOptions,
    fps: bool,
    display: Option<usize>,
) -> Result<TestHost, String> {
    let server = serve(entry, options)?;
    let entry = resolve(entry)?;
    let dir = entry.parent().unwrap_or(Path::new("."));
    let url = format!("ws://{}{WS_PATH}", server.local_addr());
    // A fresh data directory: what the app keeps (its storage) starts empty
    // in every test, as headless runs' does.
    let data = fresh_data_dir()?;
    let mut command = Command::new(host);
    command
        .env("NSH_DEV_APP_DIR", dir)
        .args(["--dev-server", &url])
        .arg("--data-dir")
        .arg(&data)
        .stdin(Stdio::null());
    if fps {
        command.arg("--fps");
    }
    if target == Target::Macos {
        // A window AppKit restored from an earlier run would not be this one.
        command.args(["-ApplePersistenceIgnoreState", "YES"]);
        // Off the main screen, which the user works on: the display
        // `--display` names, else a secondary one when there is one (the
        // host knows the screens).
        let display = display.map_or_else(|| "secondary".to_owned(), |n| n.to_string());
        command.args(["--display", &display]);
        // At the size the test opens the app at, on a display shorter than
        // it too: AppKit would shrink the window to the screen, and the
        // app would lay out in less room than the test expects.
        command.arg("--keep-window-size");
    }
    if target == Target::Gpui && cfg!(target_os = "linux") && std::env::var_os("DISPLAY").is_some()
    {
        // Screenshots read the window from the X server: under X11
        // (Xwayland on a Wayland desktop).
        command.env_remove("WAYLAND_DISPLAY");
    }
    if let Some(size) = options.size {
        command.args([
            "--window-size",
            &format!("{}x{}", size.width.0, size.height.0),
        ]);
    }
    let (mut child, output) =
        ui::quiet(&mut command).map_err(|e| format!("cannot start {}: {e}", host.display()))?;
    let deadline = Instant::now() + CONNECT;
    while !server.has_tester() {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "the host exited with {status} before it connected{}",
                indented(&output.text())
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err(format!(
                "the host did not connect in {} s{}",
                CONNECT.as_secs(),
                indented(&output.text())
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(TestHost {
        server,
        child,
        data,
    })
}

/// The entry `open` names (a file, or an app's directory: its entry, or
/// for an app of Rust only its `nsh.json`).
fn resolve(entry: &Path) -> Result<std::path::PathBuf, String> {
    crate::entry::resolve(entry).map_err(|e| format!("{e:#}"))
}

/// A dev server in a test session serving `entry`'s build, as `nsh run`
/// serves it (the app's assets, its log lines shown as `nsh run` shows
/// them); for an app of Rust only, the host's own root, which its
/// development host is built with.
pub(crate) fn serve(entry: &Path, options: &HostOptions) -> Result<DevServer, String> {
    let entry = &resolve(entry)?;
    let root = crate::rust_app::is_root(entry);
    let built = if root {
        None
    } else {
        Some(build::compile(entry, false).map_err(|e| e.plain)?)
    };
    let dir = entry.parent().unwrap_or(Path::new("."));
    let trace = options.trace.clone();
    let server = DevServer::start(
        "127.0.0.1:0".parse().expect("an address"),
        nsh_js::BYTECODE_VERSION,
        Some(dir.to_path_buf()),
        move |event| match event {
            // The app's log lines, as `nsh run` shows them (a traced app's
            // commit timings among them); the host's own coming and going
            // is the test's business.
            ClientEvent::Log(log) => {
                let level = match log.level {
                    LogLevel::Error => log::Level::Error,
                    LogLevel::Warn => log::Level::Warn,
                    LogLevel::Info => log::Level::Info,
                    LogLevel::Debug => log::Level::Debug,
                    LogLevel::Trace => log::Level::Trace,
                };
                crate::logger::forward(level, &log.target, &log.message);
            }
            ClientEvent::Trace { items } => {
                if let Some(trace) = &trace {
                    trace(items);
                }
            }
            _ => {}
        },
    )
    .map_err(|e| format!("cannot start a dev server: {e}"))?;
    server.serve_files(build::crate_assets().map(|a| (a.path, a.source)));
    server.test_session();
    // What the app starts with and what answers its requests: the test's.
    server.set_test_storage(options.storage.clone());
    server.set_test_trace(options.trace.is_some());
    server.set_test_environment(options.environment.clone());
    if let Some(network) = &options.network {
        server.set_test_network(network.clone());
    }
    let Some(built) = built else {
        server.publish_root();
        return Ok(server);
    };
    let capabilities = built.capabilities_json();
    server.publish(
        built.bytecode,
        built.code,
        built.source_map,
        AppInfo {
            capabilities,
            id: crate::package::app_id(entry).ok(),
        },
        None,
        built.ui_sets,
    );
    Ok(server)
}

/// A data directory of its own for an app a test opens: what the app
/// keeps (its storage) starts empty in every test, as headless runs' does.
pub(crate) fn fresh_data_dir() -> Result<std::path::PathBuf, String> {
    let data = std::env::temp_dir().join(format!(
        "nsh-test-{}-{}",
        std::process::id(),
        NEXT_APP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&data).map_err(|e| format!("cannot make {}: {e}", data.display()))?;
    Ok(data)
}

/// The apps started so far: each gets a data directory of its own.
static NEXT_APP: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// `text` (the host's output) on lines of its own, if there is any.
pub(crate) fn indented(text: &str) -> String {
    if text.trim().is_empty() {
        String::new()
    } else {
        format!(":\n{}", text.trim_end())
    }
}
