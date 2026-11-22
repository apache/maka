//! `nsh test --target android`: the apps tests open run on the development
//! host on an Android device or emulator (the first `adb devices` lists).
//! The host is built and installed once; each `open` builds the entry,
//! serves it in a dev server's test session of its own, forwards its port
//! to the device and starts the host on it with a data directory of its
//! own, empty when it starts. The host's test agent takes the test's steps
//! with `MotionEvent`s and `KeyEvent`s its views get as a finger's and a
//! keyboard's (`nsh-platform-android`'s `agent.rs`, `TestAgent.java`); the
//! host is stopped when the test closes the app.

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use nsh_dev::{
    DevServer,
    protocol::{TestStep, WS_PATH},
};
use nsh_testing::{Host, HostOptions, StartHost};

use crate::{
    android::{Sdk, adb},
    run::BUNDLE_ID,
};

/// How long the host may take to start and connect.
const CONNECT: Duration = Duration::from_secs(90);

/// Starts the apps tests open on the first device, installing the
/// development host there.
pub(crate) fn starter(work: &Path) -> anyhow::Result<StartHost> {
    let sdk = Arc::new(Sdk::find()?);
    let serial = crate::android::device(&sdk)?;
    crate::run::install_android_host(&sdk, &serial, work, &crate::runtime::test_android()?)?;
    Ok(Arc::new(move |entry: &Path, options: &HostOptions| {
        start(&sdk, &serial, entry, options).map(|h| Box::new(h) as Box<dyn Host>)
    }))
}

/// The development host running one app for a test.
struct DeviceHost {
    server: DevServer,
    sdk: Arc<Sdk>,
    serial: String,
    /// The forwarded port (`tcp:<port>`).
    port: String,
    /// The device's night mode before the test changed it, to restore.
    night: Mutex<Option<String>>,
}

impl Host for DeviceHost {
    fn step(&self, step: TestStep, timeout: Duration) -> Result<serde_json::Value, String> {
        match step {
            // The system's appearance is the device's: switched as its
            // settings switch it, then the app's answer waited for.
            TestStep::SetColorScheme { dark } => {
                let wanted = if dark { "yes" } else { "no" };
                let now = self.night_mode()?;
                if now == wanted {
                    return Ok(serde_json::Value::Null);
                }
                self.night
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_or_insert(now);
                self.adb(&["shell", "cmd", "uimode", "night", wanted])?;
                self.server
                    .step(TestStep::NextChange { timeout_ms: 2000 }, timeout)
            }
            step => self.server.step(step, timeout),
        }
    }
}

impl DeviceHost {
    fn adb(&self, args: &[&str]) -> Result<String, String> {
        adb(&self.sdk, &self.serial, args).map_err(|e| format!("adb {}: {e:#}", args.join(" ")))
    }

    /// The device's night mode: `yes` or `no` (`auto` and `custom` say
    /// what they resolve to).
    fn night_mode(&self) -> Result<String, String> {
        let text = self.adb(&["shell", "cmd", "uimode", "night"])?;
        // "Night mode: yes"
        Ok(text
            .rsplit(':')
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned())
    }
}

impl Drop for DeviceHost {
    fn drop(&mut self) {
        let _ = self.adb(&["shell", "am", "force-stop", BUNDLE_ID]);
        if let Some(before) = self.night.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = self.adb(&["shell", "cmd", "uimode", "night", &before]);
        }
        let _ = self.adb(&["reverse", "--remove", &self.port]);
    }
}

/// The apps started so far: each gets a data directory of its own.
static NEXT_APP: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Builds `entry`, serves it in a test session and starts the host on it.
fn start(
    sdk: &Arc<Sdk>,
    serial: &str,
    entry: &Path,
    options: &HostOptions,
) -> Result<DeviceHost, String> {
    let server = crate::test_host::serve(entry, options)?;
    let port = format!("tcp:{}", server.local_addr().port());
    let host = DeviceHost {
        server,
        sdk: sdk.clone(),
        serial: serial.to_owned(),
        port,
        night: Mutex::new(None),
    };
    // The device reaches the dev server on its own 127.0.0.1.
    host.adb(&["reverse", &host.port, &host.port])?;
    let url = format!(
        "ws://127.0.0.1:{}{WS_PATH}",
        host.server.local_addr().port()
    );
    let data = format!(
        "app-{}",
        NEXT_APP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let config = crate::package::read_config(entry).map_err(|e| format!("{e:#}"))?;
    let env = crate::run::android_app_env(&config);
    let mut start = vec![
        "shell",
        "am",
        "start",
        "-S",
        "-n",
        "com.longbridge.nsh.host/com.longbridge.nsh.DevActivity",
        "--es",
        "url",
        &url,
        "--es",
        "dataDir",
        &data,
    ];
    start.extend(env.iter().map(String::as_str));
    host.adb(&start)?;
    let deadline = Instant::now() + CONNECT;
    while !host.server.has_tester() {
        if Instant::now() >= deadline {
            return Err(format!(
                "the development host did not connect in {} s",
                CONNECT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(host)
}
