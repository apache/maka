//! Development connections and the terminal's on-demand diagnostics panel.

use std::{
    collections::VecDeque,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_dev::{
    DevClient, DevEvent, HostInfo,
    protocol::{BundleFormat, HostPlatform},
};
use nsh_engine::{App, BYTECODE_VERSION, Bundle, HotUpdate, Limits, Policy};
use ratatui_core::{
    buffer::Buffer,
    layout::{Constraint, Layout, Rect},
    widgets::Widget,
};
use ratatui_widgets::{clear::Clear, paragraph::Paragraph};

use super::{AppOptions, AppView, agent};
use crate::{Input, surface::Wake};

/// Reads `asset:/…` files (fonts) from the development server's `/assets/`, as the desktop hosts do.
pub(super) struct ServerAssets {
    base: String,
}

impl ServerAssets {
    /// The server's assets for its WebSocket URL (`ws://host:port/ws`).
    pub(super) fn for_server(url: &str) -> Option<Self> {
        let (scheme, rest) = if let Some(rest) = url.strip_prefix("ws://") {
            ("http", rest)
        } else {
            ("https", url.strip_prefix("wss://")?)
        };
        let host = rest.split('/').next().filter(|host| !host.is_empty())?;
        Some(Self {
            base: format!("{scheme}://{host}/assets/"),
        })
    }

    fn url(&self, uri: &str) -> Result<String, String> {
        let path = uri
            .strip_prefix("asset:/")
            .ok_or_else(|| format!("not an asset URI: {uri}"))?
            .trim_start_matches('/');
        Ok(format!("{}{path}", self.base))
    }
}

impl nsh_engine::Assets for ServerAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        let url = self.url(uri)?;
        let mut response = ureq::get(&url)
            .call()
            .map_err(|error| format!("{url}: {error}"))?;
        response
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .map_err(|error| format!("{url}: {error}"))
    }
}

pub(super) enum Message {
    Event(Box<DevEvent>),
    Test(agent::TestSession),
}

pub(super) struct DevSession {
    _client: Arc<DevClient>,
    pub(super) inbox: crossbeam_channel::Receiver<Message>,
    running: Option<(u64, u64)>,
    running_root: bool,
    latest: Option<(u64, u64, Bundle, Limits)>,
}

impl DevSession {
    pub(super) fn start(url: String, options: &AppOptions, wake: Arc<Wake>) -> io::Result<Self> {
        let (sender, inbox) = crossbeam_channel::unbounded();
        let host = HostInfo {
            device: format!("Terminal ({})", std::env::consts::OS),
            platform: HostPlatform::Tui,
            bytecode_version: BYTECODE_VERSION.to_owned(),
            ui_sets: options
                .ui_sets
                .iter()
                .flat_map(nsh_core::element::Registry::sets)
                .filter_map(|set| set.specifier().map(str::to_owned))
                .collect(),
            tests: true,
        };
        log::info!("Connecting to {url}");
        let attach = sender.clone();
        let test_wake = wake.clone();
        let tester = nsh_testing::agent::Tester::new(move |model| {
            let (session, native) = agent::TestSession::new(model, test_wake.clone());
            // Attachment and bundles share this ordered inbox, before engine startup.
            if attach.send(Message::Test(session)).is_ok() {
                test_wake.notify();
            }
            Box::new(native)
        });
        let tests = tester.clone();
        let client = DevClient::start(url, host, move |event| {
            let Some(event) = tests.event(event) else {
                return;
            };
            if sender.send(Message::Event(Box::new(event))).is_ok() {
                wake.notify();
            }
        })?;
        let client = Arc::new(client);
        tester.set_client(&client);
        Ok(Self {
            _client: client,
            inbox,
            running: None,
            running_root: false,
            latest: None,
        })
    }

    pub(super) fn event(&mut self, view: &mut AppView, event: DevEvent) {
        match event {
            DevEvent::Bundle {
                session,
                version,
                format,
                bytes,
                source_map,
                capabilities,
                app_id,
                window,
                limits,
            } => {
                let result = (|| -> Result<_, String> {
                    let mut bundle = match format {
                        // SAFETY: the connected developer's server compiled this for the
                        // bytecode version negotiated by DevClient's handshake.
                        BundleFormat::Bytecode => unsafe { Bundle::bytecode(bytes) },
                        BundleFormat::Source => {
                            Bundle::source(String::from_utf8(bytes).map_err(|e| e.to_string())?)
                        }
                    }
                    .with_policy(Policy::development());
                    if let Some(map) = source_map {
                        bundle = bundle.with_source_map(map);
                    }
                    let bundle = bundle
                        .with_app_id(app_id.as_deref())
                        .with_main_window(window.as_deref())
                        .with_capabilities_json(capabilities.as_deref())?;
                    Ok((bundle, Limits::development(limits.as_deref())?))
                })();
                match result {
                    Ok((bundle, limits)) => {
                        self.running_root = false;
                        self.latest = Some((session, version, bundle.clone(), limits));
                        if self.running != Some((session, version)) {
                            self.running = Some((session, version));
                            view.options.limits = limits;
                            view.diagnostics.close();
                            if let Err(error) = view.load_app(App::Js(bundle)) {
                                if let Some(test) = &view.test {
                                    test.model.error(error.to_string());
                                }
                                view.diagnostics
                                    .error("Cannot load app", &error.to_string());
                            }
                        }
                    }
                    Err(error) => {
                        if let Some(test) = &view.test {
                            test.model.error(error.clone());
                        }
                        view.diagnostics.error("Invalid development bundle", &error);
                    }
                }
            }
            DevEvent::Patch {
                session,
                version,
                base,
                code,
                source_map,
            } => {
                if self.running == Some((session, base))
                    && let Some(control) = view.surface.control()
                {
                    control.hot_update(HotUpdate {
                        name: format!("hot-{version}.js"),
                        code,
                        source_map: source_map.map(Into::into),
                    });
                    self.running = Some((session, version));
                    view.diagnostics.close();
                }
            }
            DevEvent::Connected => log::info!("Dev server connected"),
            DevEvent::Disconnected => log::warn!("Dev server disconnected; reconnecting"),
            DevEvent::Building => log::info!("Building"),
            DevEvent::BuildFailed(message) | DevEvent::CannotRun { message, .. } => {
                if let Some(test) = &view.test {
                    test.model.error(message.clone());
                }
                view.diagnostics.error("Development error", &message);
            }
            DevEvent::Root => {
                self.running_root = true;
                self.running = None;
                self.latest = None;
                if let Some(root) = view.options.root.clone() {
                    view.diagnostics.close();
                    if let Err(error) = view.load_app(App::Rust(root)) {
                        if let Some(test) = &view.test {
                            test.model.error(error.to_string());
                        }
                        view.diagnostics
                            .error("Cannot load app", &error.to_string());
                    }
                } else {
                    if let Some(test) = &view.test {
                        test.model
                            .error("This host was not built with the app's Rust root");
                    }
                    view.diagnostics.error(
                        "Cannot run app",
                        "This host was not built with the app's Rust root",
                    );
                }
            }
            DevEvent::Testing
            | DevEvent::Step { .. }
            | DevEvent::TestSetup { .. }
            | DevEvent::Fetch { .. } => {}
        }
    }

    pub(super) fn reload_latest(&mut self, view: &mut AppView) {
        if self.running_root {
            self.event(view, DevEvent::Root);
            return;
        }
        self.running = self
            .latest
            .as_ref()
            .map(|(session, version, ..)| (*session, *version));
        self.reload(view);
    }

    pub(super) fn reload(&mut self, view: &mut AppView) {
        let target = self.running.take();
        if let Some((session, version, bundle, limits)) = &self.latest
            && Some((*session, *version)) == target
        {
            self.running = target;
            view.options.limits = *limits;
            view.diagnostics.close();
            if let Err(error) = view.load_app(App::Js(bundle.clone())) {
                if let Some(test) = &view.test {
                    test.model.error(error.to_string());
                }
                view.diagnostics
                    .error("Cannot reload app", &error.to_string());
            }
        }
    }
}

const LOG_TAIL_BYTES: u64 = 64 * 1024;
const ERROR_LINES: usize = 256;
const ERROR_LINE_CHARS: usize = 4096;

pub(super) struct Diagnostics {
    pub(super) log_path: Option<PathBuf>,
    pub(super) open: bool,
    pub(super) refresh: Instant,
    pub(super) reload: bool,
    pub(super) toggle_perf: bool,
    prefix: bool,
    errors: VecDeque<String>,
    lines: String,
    scroll: (u16, u16),
    follow: bool,
}

impl Default for Diagnostics {
    fn default() -> Self {
        Self {
            log_path: None,
            open: false,
            refresh: Instant::now(),
            reload: false,
            toggle_perf: false,
            prefix: false,
            errors: VecDeque::new(),
            lines: String::new(),
            scroll: (0, 0),
            follow: true,
        }
    }
}

impl Diagnostics {
    pub(super) fn close(&mut self) {
        self.open = false;
        self.prefix = false;
    }

    pub(super) fn error(&mut self, title: &str, message: &str) {
        log::error!("{title}: {message}");
        for line in std::iter::once(title).chain(message.lines()) {
            if self.errors.len() == ERROR_LINES {
                self.errors.pop_front();
            }
            self.errors
                .push_back(line.chars().take(ERROR_LINE_CHARS).collect());
        }
        self.open = true;
        self.follow = true;
        self.refresh = Instant::now();
    }

    pub(super) fn handle(&mut self, input: &Input) -> bool {
        if matches!(input, Input::Focus(false)) {
            self.prefix = false;
        }
        let (key, modifiers, release) = match input {
            Input::Key {
                key,
                modifiers,
                release,
            } => (key, modifiers, *release),
            Input::KeyRepeat { key, modifiers } => (key, modifiers, false),
            _ => return self.open && !matches!(input, Input::Focus(_)),
        };
        if release {
            return self.open || self.prefix;
        }
        if self.prefix {
            self.prefix = false;
            if key == "p" && !modifiers.ctrl && !modifiers.alt && !modifiers.cmd {
                self.toggle_perf = true;
                return true;
            }
            if key == "e" && !modifiers.ctrl && !modifiers.alt && !modifiers.cmd {
                self.open = !self.open;
                self.follow = true;
                self.refresh = Instant::now();
                return true;
            }
        }
        if key == "h" && modifiers.ctrl && !modifiers.alt && !modifiers.cmd && !modifiers.shift {
            self.prefix = true;
            return true;
        }
        if !self.open {
            return false;
        }
        match key.as_str() {
            "Escape" | "q" => self.close(),
            "g" if modifiers.ctrl => self.close(),
            "r" => self.reload = true,
            "Up" => {
                self.follow = false;
                self.scroll.0 = self.scroll.0.saturating_sub(1);
            }
            "PageUp" => {
                self.follow = false;
                self.scroll.0 = self.scroll.0.saturating_sub(10);
            }
            "Down" => {
                self.follow = false;
                self.scroll.0 = self.scroll.0.saturating_add(1);
            }
            "PageDown" => {
                self.follow = false;
                self.scroll.0 = self.scroll.0.saturating_add(10);
            }
            "Home" => {
                self.follow = false;
                self.scroll.0 = 0;
            }
            "End" => self.follow = true,
            "Left" => self.scroll.1 = self.scroll.1.saturating_sub(8),
            "Right" => self.scroll.1 = self.scroll.1.saturating_add(8),
            _ => {}
        }
        true
    }

    pub(super) fn draw(&mut self, area: Rect, buffer: &mut Buffer) {
        if !self.open {
            return;
        }
        if self.refresh <= Instant::now() {
            let mut bytes = Vec::new();
            if let Some(path) = &self.log_path
                && let Ok(mut file) = File::open(path)
                && let Ok(metadata) = file.metadata()
            {
                let start = metadata.len().saturating_sub(LOG_TAIL_BYTES);
                if file.seek(SeekFrom::Start(start)).is_ok() {
                    let _ = file.take(LOG_TAIL_BYTES).read_to_end(&mut bytes);
                }
            }
            self.lines = String::from_utf8_lossy(&bytes)
                .chars()
                .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
                .collect();
            for error in &self.errors {
                self.lines.push('\n');
                self.lines
                    .extend(error.chars().filter(|c| !c.is_control() || *c == '\t'));
            }
            self.refresh = Instant::now() + Duration::from_millis(250);
        }
        let [title, body, hint] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(0),
            Constraint::Length(1),
        ])
        .areas(area);
        let end = self
            .lines
            .lines()
            .count()
            .saturating_sub(usize::from(body.height))
            .min(usize::from(u16::MAX)) as u16;
        self.scroll.0 = if self.follow {
            end
        } else {
            self.scroll.0.min(end)
        };
        Clear.render(area, buffer);
        Paragraph::new("Logs and errors").render(title, buffer);
        Paragraph::new(self.lines.as_str())
            .scroll(self.scroll)
            .render(body, buffer);
        Paragraph::new(
            "Esc/C-g close | r reload | arrows/PgUp/PgDn scroll | C-h e logs | C-h p performance",
        )
        .render(hint, buffer);
    }
}
