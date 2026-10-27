//! Development support: loads bundles from a `nsh dev` server, forwards
//! logs to the developer's terminal and shows errors over the app.

use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};

use nsh_dev::{
    DevClient, DevEvent, HostInfo,
    protocol::{BundleFormat, HostPlatform},
};
use nsh_engine::{BYTECODE_VERSION, Bundle, Limits, Policy};

use crate::host::Host;

/// The client of the most recent session: logs go there.
static CLIENT: Mutex<Weak<DevClient>> = Mutex::new(Weak::new());
static CONNECTED: AtomicBool = AtomicBool::new(false);

/// Sends a log line to the dev server; false if not connected.
pub(crate) fn forward(level: log::Level, target: &str, message: &str) -> bool {
    if !CONNECTED.load(Ordering::Relaxed) {
        return false;
    }
    match CLIENT.lock().ok().and_then(|c| c.upgrade()) {
        Some(client) => {
            client.log(level.into(), target, message);
            true
        }
        None => false,
    }
}

/// A connection to a dev server, loading its bundles into one view.
pub(crate) struct DevSession {
    _client: Arc<DevClient>,
    state: Arc<Mutex<DevState>>,
}

#[derive(Default)]
struct DevState {
    /// Build the app runs (loaded, or reached by hot updates): the server
    /// run it came from and its number.
    running: Option<(u64, u64)>,
    /// The latest bundle, for reloads.
    latest: Option<Bundle>,
}

impl DevSession {
    pub(crate) fn start(host: Arc<Host>, url: String) -> Option<DevSession> {
        host.dev_status(Some(&format!("Connecting to {url}…")));
        let weak = Arc::downgrade(&host);
        let state = Arc::new(Mutex::new(DevState::default()));
        let client_state = state.clone();
        let host_info = HostInfo {
            device: device_name(),
            platform: HostPlatform::Android,
            bytecode_version: BYTECODE_VERSION.to_owned(),
            ui_sets: crate::ui_sets()
                .iter()
                .flat_map(nsh_core::element::Registry::sets)
                .filter_map(|set| set.specifier().map(str::to_owned))
                .collect(),
            tests: true,
        };
        // A test session (`nsh test --target android`): the host keeps the
        // model the agent's steps see, from the first bundle on (the
        // client's events come in order on its thread).
        let tested = weak.clone();
        let tester = nsh_testing::agent::Tester::new(move |model| {
            let density = tested.upgrade().map_or(1.0, |host| {
                *host.test_model.lock().unwrap_or_else(|e| e.into_inner()) = Some(model);
                host.density()
            });
            Box::new(crate::agent::AndroidNative::new(tested.clone(), density))
        });
        let tests = tester.clone();
        let started = DevClient::start(url, host_info, move |event| {
            // Taken here: a step waits for what it does on the UI thread.
            let Some(event) = tests.event(event) else {
                return;
            };
            match event {
                DevEvent::Connected => CONNECTED.store(true, Ordering::Relaxed),
                DevEvent::Disconnected => CONNECTED.store(false, Ordering::Relaxed),
                _ => {}
            }
            if let Some(host) = weak.upgrade() {
                handle(&host, &client_state, event);
            }
        });
        match started {
            Ok(client) => {
                let client = Arc::new(client);
                tester.set_client(&client);
                *CLIENT.lock().unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(&client);
                Some(DevSession {
                    _client: client,
                    state,
                })
            }
            Err(err) => {
                log::error!("cannot start the dev client: {err}");
                None
            }
        }
    }

    pub(crate) fn show_error(&self, host: &Host, title: &str, message: &str) {
        host.dev_error(Some((title, message)), false);
    }

    /// A hot update failed: loads the latest bundle from scratch (on its
    /// own thread: this is called on the engine thread, which the reload
    /// stops).
    pub(crate) fn reload(&self, host: &Arc<Host>) {
        let latest = self.state.lock().ok().and_then(|s| s.latest.clone());
        if let Some(bundle) = latest {
            let host = host.clone();
            let _ = std::thread::Builder::new()
                .name("nsh-dev-reload".into())
                .spawn(move || {
                    log::info!("reloading after an update that could not be applied in place");
                    host.load(bundle);
                });
        }
    }
}

fn handle(host: &Arc<Host>, state: &Mutex<DevState>, event: DevEvent) {
    match event {
        DevEvent::Connected => host.dev_status(None),
        DevEvent::Disconnected => host.dev_status(Some("Dev server disconnected — reconnecting…")),
        // The client's thread hands them to the test agent.
        DevEvent::Testing
        | DevEvent::Step { .. }
        | DevEvent::TestSetup { .. }
        | DevEvent::Fetch { .. } => {}
        DevEvent::Root => {
            host.dev_status(None);
            let Some(root) = crate::app_root() else {
                return host.dev_error(
                    Some((
                        "This host cannot run the app",
                        "The app is of Rust only, and this host was not built with its root.",
                    )),
                    true,
                );
            };
            {
                let mut state = state.lock().expect("dev state");
                state.latest = None;
                state.running = None;
            }
            host.dev_error(None, false);
            host.load(root);
        }
        DevEvent::Building => {}
        DevEvent::BuildFailed(message) => host.dev_error(Some(("Build failed", &message)), false),
        DevEvent::CannotRun { message, .. } => {
            host.dev_status(None);
            host.dev_error(Some(("This host cannot run the app", &message)), true)
        }
        DevEvent::Bundle {
            session,
            version,
            format,
            bytes,
            source_map,
            capabilities,
            app_id,
            limits,
        } => {
            let mut bundle = match format {
                // SAFETY: compiled for this runtime's bytecode version (the
                // handshake) by the dev server the developer connected to.
                BundleFormat::Bytecode => {
                    unsafe { Bundle::bytecode(bytes) }.with_policy(Policy::development())
                }
                BundleFormat::Source => match String::from_utf8(bytes) {
                    Ok(code) => Bundle::source(code).with_policy(Policy::development()),
                    Err(_) => {
                        return host.dev_error(
                            Some(("Invalid bundle", "the dev server sent non-UTF-8 source")),
                            true,
                        );
                    }
                },
            };
            if let Some(map) = source_map {
                bundle = bundle.with_source_map(map);
            }
            bundle = bundle.with_app_id(app_id.as_deref());
            bundle = match bundle.with_capabilities_json(capabilities.as_deref()) {
                Ok(bundle) => bundle,
                Err(err) => return host.dev_error(Some(("Invalid capabilities", &err)), true),
            };
            let limits = match Limits::development(limits.as_deref()) {
                Ok(limits) => limits,
                Err(err) => return host.dev_error(Some(("Invalid limits", &err)), true),
            };
            host.dev_status(None);
            let running = {
                let mut state = state.lock().expect("dev state");
                state.latest = Some(bundle.clone());
                state.running.replace((session, version))
            };
            // Already there through a hot update.
            if running == Some((session, version)) {
                return;
            }
            log::info!("loading build {version}");
            host.dev_error(None, false);
            host.set_limits(limits);
            host.load(bundle);
        }
        DevEvent::Patch {
            session,
            version,
            base,
            code,
            source_map,
        } => {
            let mut state = state.lock().expect("dev state");
            if state.running != Some((session, base)) {
                return;
            }
            let update = nsh_engine::HotUpdate {
                name: format!("hot-{version}.js"),
                code,
                source_map: source_map.map(Into::into),
            };
            if host.hot_update(update) {
                log::info!("updating to build {version}");
                state.running = Some((session, version));
                host.dev_error(None, false);
            }
        }
    }
}

/// "Android (Pixel 7)", "Android Emulator (sdk_gphone64_arm64)".
fn device_name() -> String {
    let model = property(c"ro.product.model").unwrap_or_default();
    let emulator = property(c"ro.kernel.qemu").as_deref() == Some("1")
        || property(c"ro.boot.qemu").as_deref() == Some("1");
    if emulator {
        format!("Android Emulator ({model})")
    } else {
        format!("Android ({model})")
    }
}

fn property(name: &std::ffi::CStr) -> Option<String> {
    let mut value = [0 as std::ffi::c_char; 92];
    // SAFETY: `value` has the documented PROP_VALUE_MAX (92) bytes.
    let len = unsafe { libc::__system_property_get(name.as_ptr(), value.as_mut_ptr()) };
    if len <= 0 {
        return None;
    }
    // SAFETY: the property value is NUL-terminated within the buffer.
    Some(
        unsafe { std::ffi::CStr::from_ptr(value.as_ptr()) }
            .to_string_lossy()
            .into_owned(),
    )
}
