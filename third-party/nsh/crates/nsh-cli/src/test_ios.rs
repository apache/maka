//! `nsh test --target ios`: the apps tests open run on the development host
//! in an iOS simulator. The host is installed once; each `open` builds the
//! entry, serves it in a dev server's test session of its own and launches
//! the host on it with a fresh data directory (the simulator shares this
//! Mac's network and files). The host's test agent takes the test's steps
//! with touches and keys UIKit takes as the system's
//! (`nsh-platform-ios`'s `agent.rs`); the host is terminated when the test
//! closes the app.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_dev::{
    DevServer,
    protocol::{TestStep, WS_PATH},
};
use nsh_testing::{Host, HostOptions, StartHost};

use crate::run::{BUNDLE_ID, simctl};

/// How long the host may take to launch and connect.
const CONNECT: Duration = Duration::from_secs(90);

/// Starts the apps tests open in a simulator (a booted one, else the
/// newest iPhone, booted first), installing the development host there;
/// `fps` has it log its performance monitor's readings.
pub(crate) fn starter(work: &Path, fps: bool) -> anyhow::Result<StartHost> {
    let host = crate::runtime::test_host(crate::runtime::Platform::IphoneSimulator)?;
    let udid = crate::run::simulator(None)?;
    let app = crate::run::package_ios(&work.join("ios"), &host)?;
    let step = crate::ui::Step::start("installing the development host in the simulator");
    simctl(&["install", &udid, &app.to_string_lossy()])?;
    step.finish();
    Ok(Arc::new(move |entry: &Path, options: &HostOptions| {
        start(&udid, entry, options, fps).map(|h| Box::new(h) as Box<dyn Host>)
    }))
}

/// The development host running one app for a test.
struct SimulatorHost {
    server: DevServer,
    udid: String,
    /// The app's data directory, fresh for it and removed after it.
    data: PathBuf,
    /// The simulator's appearance before the test changed it, to restore.
    appearance: std::sync::Mutex<Option<String>>,
}

impl Host for SimulatorHost {
    fn step(&self, step: TestStep, timeout: Duration) -> Result<serde_json::Value, String> {
        match step {
            // The system's appearance is the simulator's: switched as its
            // settings switch it, then the app's answer waited for.
            TestStep::SetColorScheme { dark } => {
                let wanted = if dark { "dark" } else { "light" };
                let now = appearance(&self.udid)?;
                if now == wanted {
                    return Ok(serde_json::Value::Null);
                }
                self.appearance
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_or_insert(now);
                simctl(&["ui", &self.udid, "appearance", wanted])
                    .map_err(|e| format!("cannot switch the simulator's appearance: {e:#}"))?;
                self.server
                    .step(TestStep::NextChange { timeout_ms: 2000 }, timeout)
            }
            step => self.server.step(step, timeout),
        }
    }
}

impl Drop for SimulatorHost {
    fn drop(&mut self) {
        let _ = simctl(&["terminate", &self.udid, BUNDLE_ID]);
        if let Some(before) = self
            .appearance
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = simctl(&["ui", &self.udid, "appearance", &before]);
        }
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

/// The simulator's appearance: `light` or `dark`.
fn appearance(udid: &str) -> Result<String, String> {
    simctl(&["ui", udid, "appearance"])
        .map(|s| s.trim().to_owned())
        .map_err(|e| format!("cannot read the simulator's appearance: {e:#}"))
}

/// Builds `entry`, serves it in a test session and launches the host on it.
fn start(
    udid: &str,
    entry: &Path,
    options: &HostOptions,
    fps: bool,
) -> Result<SimulatorHost, String> {
    let server = crate::test_host::serve(entry, options)?;
    let url = format!("ws://{}{WS_PATH}", server.local_addr());
    let data = crate::test_host::fresh_data_dir()?;
    let data_arg = data.to_string_lossy().into_owned();
    let mut launch = vec![
        "launch",
        "--terminate-running-process",
        udid,
        BUNDLE_ID,
        "--dev-server",
        &url,
        "--data-dir",
        &data_arg,
    ];
    if fps {
        launch.push("--fps");
    }
    simctl(&launch).map_err(|e| format!("cannot launch the development host: {e:#}"))?;
    let deadline = Instant::now() + CONNECT;
    while !server.has_tester() {
        if Instant::now() >= deadline {
            let _ = simctl(&["terminate", udid, BUNDLE_ID]);
            return Err(format!(
                "the development host did not connect in {} s",
                CONNECT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(SimulatorHost {
        server,
        udid: udid.to_owned(),
        data,
        appearance: std::sync::Mutex::new(None),
    })
}
