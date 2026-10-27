use std::{
    cell::Cell,
    collections::HashSet,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use anyhow::Context as _;
use notify::{RecursiveMode, Watcher};
use nsh_dev::{
    ClientEvent, DevServer,
    protocol::{HostPlatform, WS_PATH},
};

use crate::{build, logger, ui};

/// File events arriving within this window are coalesced into one rebuild.
const DEBOUNCE: Duration = Duration::from_millis(30);

/// A running dev server plus the source watcher feeding it.
pub(crate) struct DevSession {
    entry: PathBuf,
    src_dir: PathBuf,
    release: bool,
    server: DevServer,
    devices: Arc<Devices>,
    /// The modules of the last good development build: updates are
    /// computed against it.
    hot: std::cell::RefCell<Option<nsh_bundler::HotBundle>>,
    /// Files read by the last good build (imports may be outside the app).
    watch_files: std::cell::RefCell<Vec<PathBuf>>,
    /// Good builds so far: the first one is "built", the next "rebuilt".
    builds: Cell<u32>,
    /// A Rust app (`nsh.json` `"root"`): nothing to bundle, the hosts run
    /// its root; the session serves its assets, its web page and its logs.
    rust_root: bool,
}

impl DevSession {
    /// Starts the server and publishes the first build (or its error).
    /// Hosts run the app with `limits` as an embedding app that sets them
    /// would (`--limits`), or with none, as an app on its own.
    pub(crate) fn start(
        entry: &Path,
        port: u16,
        release: bool,
        limits: Option<nsh_core::js::HostLimits>,
    ) -> anyhow::Result<DevSession> {
        let entry = dunce::canonicalize(entry)
            .with_context(|| format!("entry not found: {}", entry.display()))?;
        let src_dir = entry
            .parent()
            .context("entry has no directory")?
            .to_path_buf();
        let devices = Arc::<Devices>::default();
        let server = start_server(port, &src_dir, devices.clone())?;
        server.serve_files(crate::build::crate_assets().map(|a| (a.path, a.source)));
        server.install_commands(install_commands(&src_dir));
        server.set_limits(limits.map(|l| l.to_string()));
        // Browsers too, when there is a web runtime to serve (`nsh run
        // --target web` builds it in a checkout).
        let rust_root = crate::rust_app::is_root(&entry);
        if let Ok(Some(runtime)) = crate::runtime::web(crate::runtime::WebKind::Dev, false) {
            let (page, files) =
                crate::web::with_page_host(crate::web::dev_host(&runtime, rust_root)?, &entry)?;
            server.serve_web(page, files);
        }
        let session = DevSession {
            entry,
            src_dir,
            release,
            server,
            devices,
            hot: Default::default(),
            watch_files: Default::default(),
            builds: Cell::new(0),
            rust_root,
        };
        session.rebuild();
        Ok(session)
    }

    /// The port the dev server listens on.
    pub(crate) fn port(&self) -> u16 {
        self.server.local_addr().port()
    }

    /// WebSocket URL for hosts on this machine.
    pub(crate) fn local_url(&self) -> String {
        format!(
            "ws://127.0.0.1:{}{WS_PATH}",
            self.server.local_addr().port()
        )
    }

    /// The web host's page for browsers on this machine.
    pub(crate) fn web_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.server.local_addr().port())
    }

    /// Prints where hosts can connect.
    pub(crate) fn print_urls(&self) {
        let port = self.server.local_addr().port();
        ui::note(format!("dev server {}", self.local_url()));
        let web = self.server.serves_web();
        if web {
            ui::detail(format!("browsers: {}", self.web_url()));
        }
        for ip in lan_ips() {
            ui::detail(format!(
                "devices on this network: ws://{ip}:{port}{WS_PATH}"
            ));
            if web {
                ui::detail(format!("browsers on this network: http://{ip}:{port}/"));
            }
        }
    }

    /// Prints the page browsers open (`nsh run --target web`): the one
    /// address to open here, and dimmed, the same on this network (phones).
    pub(crate) fn print_web_url(&self) {
        let port = self.server.local_addr().port();
        ui::note(format!("open in a browser: {}", ui::link(&self.web_url())));
        if let Some(ip) = lan_ips().first() {
            ui::detail(ui::dim(format!("on this network: http://{ip}:{port}/")));
        }
    }

    /// Rebuilds on source changes until `stop` returns true.
    pub(crate) fn watch(&self, stop: impl FnMut() -> anyhow::Result<bool>) -> anyhow::Result<()> {
        let result = self.watch_until(stop);
        // The session is over: its hosts going away (stopped by the
        // command, or with the server) is no news.
        self.devices.closing.store(true, Ordering::Relaxed);
        result
    }

    fn watch_until(&self, mut stop: impl FnMut() -> anyhow::Result<bool>) -> anyhow::Result<()> {
        let (tx, rx) = mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    let _ = tx.send(event);
                }
            })?;
        watcher.watch(&self.src_dir, RecursiveMode::Recursive)?;
        ui::debug(format!("watching {}", ui::path(&self.src_dir)));
        // The app's Rust code: a change builds the app's hosts again.
        let rust = crate::rust_app::current();
        for dir in rust.iter().flat_map(|app| app.watched()) {
            if !dir.starts_with(&self.src_dir) {
                watcher.watch(dir, RecursiveMode::Recursive)?;
            }
        }
        let mut imported_dirs = HashSet::new();
        self.watch_imports(&mut watcher, &mut imported_dirs)?;
        loop {
            if ui::stop_requested() || stop()? {
                return Ok(());
            }
            let Ok(event) = rx.recv_timeout(Duration::from_millis(200)) else {
                continue;
            };
            // inotify reports reads too (FSEvents does not): the build's
            // own would start the next one, forever.
            if matches!(event.kind, notify::EventKind::Access(_)) {
                continue;
            }
            if let Some(app) = &rust
                && event.paths.iter().any(|p| app.is_rust(p))
            {
                return Err(crate::rust_app::Restart.into());
            }
            if !is_source(&event) {
                continue;
            }
            let deadline = Instant::now() + DEBOUNCE;
            while rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .is_ok()
            {}
            self.rebuild();
            self.watch_imports(&mut watcher, &mut imported_dirs)?;
        }
    }

    /// Watch the directories of shared imports, so atomic saves and new
    /// modules work as they do inside the app. Its own tree is watched above.
    fn watch_imports(
        &self,
        watcher: &mut impl Watcher,
        watched: &mut HashSet<PathBuf>,
    ) -> anyhow::Result<()> {
        for dir in self
            .watch_files
            .borrow()
            .iter()
            .filter_map(|path| path.parent())
        {
            if !dir.starts_with(&self.src_dir) && watched.insert(dir.to_path_buf()) {
                watcher.watch(dir, RecursiveMode::NonRecursive)?;
                ui::debug(format!("watching shared source {}", ui::path(dir)));
            }
        }
        Ok(())
    }

    fn rebuild(&self) {
        // A Rust app has no JS: its Rust code's changes restart the session.
        if self.rust_root {
            return;
        }
        self.server.building();
        if self.release {
            match build::compile(&self.entry, true) {
                Ok(built) => {
                    self.watch_files.replace(built.watch_files.clone());
                    let capabilities = built.capabilities_json();
                    let summary = self.summary(&built);
                    self.server.publish(
                        built.bytecode,
                        built.code,
                        built.source_map,
                        nsh_dev::AppInfo {
                            capabilities,
                            id: crate::package::app_id(&self.entry).ok(),
                        },
                        None,
                        built.ui_sets,
                    );
                    self.published(summary);
                }
                Err(err) => self.failed(err),
            }
            return;
        }
        match build::compile_hot(&self.entry) {
            Ok((built, hot)) => {
                self.watch_files.replace(built.watch_files.clone());
                let summary = self.summary(&built);
                // Other capabilities: the app starts again under them.
                let patch = self
                    .hot
                    .borrow()
                    .as_ref()
                    .filter(|previous| previous.capabilities == hot.capabilities)
                    .map(|previous| hot.patch(previous));
                let patch = match patch {
                    Some(nsh_bundler::HotPatch::Update { code, source_map }) => {
                        Some((code, source_map))
                    }
                    // Nothing to replace; hosts still clear a build error.
                    Some(nsh_bundler::HotPatch::Unchanged) => Some(("true".to_owned(), None)),
                    Some(nsh_bundler::HotPatch::Reload) | None => None,
                };
                let capabilities = built.capabilities_json();
                self.server.publish(
                    built.bytecode,
                    built.code,
                    built.source_map,
                    nsh_dev::AppInfo {
                        capabilities,
                        id: crate::package::app_id(&self.entry).ok(),
                    },
                    patch,
                    built.ui_sets,
                );
                *self.hot.borrow_mut() = Some(hot);
                self.published(summary);
            }
            Err(err) => self.failed(err),
        }
    }

    /// What the line of a good build says after its path.
    fn summary(&self, built: &build::Built) -> String {
        if self.builds.get() == 0 {
            built.summary("")
        } else {
            ui::dim(format!("({})", ui::duration(built.elapsed)))
        }
    }

    /// `✓ built App.tsx (...)`, then `✓ rebuilt App.tsx (18ms), 2 devices`.
    fn published(&self, summary: String) {
        let entry = ui::path(&self.entry);
        let builds = self.builds.get();
        self.builds.set(builds + 1);
        if builds == 0 {
            return ui::done(format!("built {entry} {summary}"));
        }
        let devices = match self.server.clients() {
            0 => String::new(),
            1 => ", 1 device".to_owned(),
            n => format!(", {n} devices"),
        };
        ui::done(format!("rebuilt {entry} {summary}{}", ui::dim(devices)));
    }

    fn failed(&self, err: build::BuildError) {
        let plain = err.plain.clone();
        ui::report(&err.into_error(&self.entry));
        self.server.publish_error(plain);
    }
}

impl Drop for DevSession {
    fn drop(&mut self) {
        // The server stops next.
        self.devices.closing.store(true, Ordering::Relaxed);
    }
}

/// The hosts connected to the dev server: what they do is shown as `•`
/// lines, their log lines with their names.
#[derive(Default)]
struct Devices {
    connected: Mutex<Vec<String>>,
    /// The session ends.
    closing: AtomicBool,
}

impl Devices {
    fn connected(&self) -> std::sync::MutexGuard<'_, Vec<String>> {
        self.connected.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn on_event(&self, event: ClientEvent) {
        match event {
            ClientEvent::Connected { device, build } => {
                let build = build.map_or(String::new(), |b| format!(", build {b}"));
                ui::event(format!("{device} connected{build}"));
                self.connected().push(device);
            }
            ClientEvent::CannotRun {
                device,
                missing,
                install,
            } => {
                let label = short_name(&self.connected(), &device);
                let install =
                    install.map_or(String::new(), |c| format!(": {c} installs this app's host"));
                ui::warn(format!(
                    "{label}: its host has no {} (it was built for another app){install}",
                    missing.join(", ")
                ));
            }
            ClientEvent::Disconnected { device } => {
                {
                    let mut connected = self.connected();
                    if let Some(i) = connected.iter().position(|d| *d == device) {
                        connected.remove(i);
                    }
                }
                if !self.closing.load(Ordering::Relaxed) {
                    ui::event(ui::dim(format!("{device} disconnected")));
                }
            }
            ClientEvent::Log(log) => {
                let (label, several) = {
                    let connected = self.connected();
                    (short_name(&connected, &log.device), connected.len() > 1)
                };
                let device = logger::Device {
                    name: &log.device,
                    label: &label,
                    several,
                };
                logger::device(&device, log.level, &log.target, &log.message);
            }
            // Only a test session's traced app sends its batches.
            ClientEvent::Trace { .. } => {}
        }
    }
}

/// `device` without its model ("iOS Simulator (iPhone 16 Plus)": "iOS
/// Simulator"), unless another connected device has that name too.
fn short_name(connected: &[String], device: &str) -> String {
    let short = |name: &str| name.split_once(" (").map_or(name, |(s, _)| s).to_owned();
    let name = short(device);
    let shared = connected
        .iter()
        .any(|other| other != device && short(other) == name);
    if shared { device.to_owned() } else { name }
}

/// The commands that install the app in `dir`'s host, for the platforms
/// `nsh run` has a target for.
fn install_commands(dir: &Path) -> Vec<(HostPlatform, String)> {
    let app = match ui::path(dir) {
        dot if dot == "." => String::new(),
        path if path.contains(' ') => format!(" '{path}'"),
        path => format!(" {path}"),
    };
    use crate::run::Target;
    // The target this machine's `nsh run` defaults to goes without a flag.
    let run = |target: Target, name: &str| {
        if target == Target::native() {
            format!("nsh run{app}")
        } else {
            format!("nsh run{app} --target {name}")
        }
    };
    vec![
        (HostPlatform::MacCatalyst, run(Target::Catalyst, "catalyst")),
        (HostPlatform::MacOs, run(Target::Macos, "macos")),
        (HostPlatform::Linux, run(Target::Linux, "linux")),
        (HostPlatform::Windows, run(Target::Windows, "windows")),
        (HostPlatform::Gpui, run(Target::Gpui, "gpui")),
        (HostPlatform::Tui, run(Target::Tui, "tui")),
        (HostPlatform::IosSimulator, run(Target::Ios, "ios")),
        (HostPlatform::Android, run(Target::Android, "android")),
        (HostPlatform::Web, run(Target::Web, "web")),
    ]
}

fn start_server(port: u16, assets_root: &Path, devices: Arc<Devices>) -> anyhow::Result<DevServer> {
    if ui::stop_requested() {
        anyhow::bail!("development session is stopping");
    }
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    DevServer::start(
        addr,
        nsh_js::BYTECODE_VERSION,
        Some(assets_root.to_path_buf()),
        move |event| devices.on_event(event),
    )
    .map_err(|error| {
        let message = if error.kind() == std::io::ErrorKind::AddrInUse {
            format!(
                "start dev server: port {port} is taken; stop what uses it or choose another --port"
            )
        } else {
            format!("start dev server on port {port}")
        };
        anyhow::Error::new(error).context(message)
    })
}

fn is_source(event: &notify::Event) -> bool {
    event.paths.iter().any(|p| {
        !p.components()
            .any(|c| c.as_os_str() == ".nsh" || c.as_os_str() == "node_modules")
            && matches!(
                p.extension().and_then(|e| e.to_str()),
                Some("ts" | "tsx" | "js" | "jsx" | "json")
            )
    })
}

/// Private IPv4 addresses of physical network interfaces (`en*`; on Linux
/// also `eth*` and Wi-Fi's `wl*`), where devices on the same Wi-Fi or
/// Ethernet can reach this machine. VPN and proxy tunnels are skipped.
#[cfg(unix)]
fn lan_ips() -> Vec<Ipv4Addr> {
    let mut ips = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills a linked list that we walk read-only and free
    // with freeifaddrs.
    unsafe {
        if libc::getifaddrs(&mut list) != 0 {
            return ips;
        }
        let mut cur = list;
        while let Some(ifa) = cur.as_ref() {
            cur = ifa.ifa_next;
            if ifa.ifa_addr.is_null() || i32::from((*ifa.ifa_addr).sa_family) != libc::AF_INET {
                continue;
            }
            let name = std::ffi::CStr::from_ptr(ifa.ifa_name).to_string_lossy();
            if !["en", "eth", "wl"].iter().any(|p| name.starts_with(p)) {
                continue;
            }
            let addr = &*(ifa.ifa_addr as *const libc::sockaddr_in);
            let ip = Ipv4Addr::from(u32::from_be(addr.sin_addr.s_addr));
            if ip.is_private() && !ips.contains(&ip) {
                ips.push(ip);
            }
        }
        libc::freeifaddrs(list);
    }
    ips
}

/// Private IPv4 addresses of the Ethernet and Wi-Fi adapters that are up
/// (by Windows' interface types: VPN, Hyper-V and WSL adapters are of
/// other types).
#[cfg(windows)]
fn lan_ips() -> Vec<Ipv4Addr> {
    use windows_sys::Win32::{
        Foundation::ERROR_BUFFER_OVERFLOW,
        NetworkManagement::{
            IpHelper::{
                GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
                GetAdaptersAddresses, IF_TYPE_ETHERNET_CSMACD, IF_TYPE_IEEE80211,
                IP_ADAPTER_ADDRESSES_LH,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::{AF_INET, SOCKADDR_IN},
    };

    let mut ips = Vec::new();
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    // u64s keep the structures written into the buffer aligned.
    let mut buffer: Vec<u64> = vec![0; 2048];
    loop {
        let mut size = (buffer.len() * 8) as u32;
        // SAFETY: the buffer holds `size` writable bytes.
        let result = unsafe {
            GetAdaptersAddresses(
                u32::from(AF_INET),
                flags,
                std::ptr::null(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if result == ERROR_BUFFER_OVERFLOW {
            buffer = vec![0; (size as usize).div_ceil(8)];
            continue;
        }
        if result != 0 {
            return ips;
        }
        break;
    }
    let mut adapter = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    // SAFETY: the call filled the buffer with a linked list of adapters and
    // their addresses, all inside it, walked read-only while it lives.
    unsafe {
        while let Some(a) = adapter.as_ref() {
            adapter = a.Next;
            if a.OperStatus != IfOperStatusUp
                || !matches!(a.IfType, IF_TYPE_ETHERNET_CSMACD | IF_TYPE_IEEE80211)
            {
                continue;
            }
            let mut unicast = a.FirstUnicastAddress;
            while let Some(u) = unicast.as_ref() {
                unicast = u.Next;
                let addr = u.Address.lpSockaddr;
                if addr.is_null() || (*addr).sa_family != AF_INET {
                    continue;
                }
                let addr = &*(addr as *const SOCKADDR_IN);
                let ip = Ipv4Addr::from(u32::from_be(addr.sin_addr.S_un.S_addr));
                if ip.is_private() && !ips.contains(&ip) {
                    ips.push(ip);
                }
            }
        }
    }
    ips
}

#[cfg(test)]
mod tests {
    #[test]
    fn occupied_port_fails_without_moving_or_stopping_the_listener() {
        let taken = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        let error = super::start_server(port, &std::env::temp_dir(), Default::default())
            .err()
            .expect("must not move to another port");
        assert!(error.to_string().contains(&format!("port {port}")));
        assert_eq!(
            error
                .root_cause()
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .kind(),
            std::io::ErrorKind::AddrInUse
        );
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn zero_allocates_a_port_and_an_explicit_port_is_kept() {
        let dir = std::env::temp_dir();
        let server = super::start_server(0, &dir, Default::default()).unwrap();
        let port = server.local_addr().port();
        assert_ne!(port, 0);
        drop(server);
        let server = super::start_server(port, &dir, Default::default()).unwrap();
        assert_eq!(server.local_addr().port(), port);
    }

    #[test]
    fn devices_go_by_short_names_unless_two_share_one() {
        let connected = [
            "iOS Simulator (iPhone 16 Plus)".to_owned(),
            "Mac Catalyst".to_owned(),
        ];
        assert_eq!(
            super::short_name(&connected, &connected[0]),
            "iOS Simulator"
        );
        assert_eq!(
            super::short_name(&connected, "Mac Catalyst"),
            "Mac Catalyst"
        );
        let two = [
            "iOS Simulator (iPhone 16 Plus)".to_owned(),
            "iOS Simulator (iPad Air)".to_owned(),
        ];
        assert_eq!(super::short_name(&two, &two[1]), "iOS Simulator (iPad Air)");
    }
}
