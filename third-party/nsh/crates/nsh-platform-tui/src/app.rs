//! Embeddable engines and the standalone terminal runner. Terminal IO is
//! exclusively owned by `run_app`; an `AppView` can render in a host's buffer.

#[cfg(feature = "dev")]
use std::sync::Mutex;
use std::{
    collections::VecDeque,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    sync::{Arc, RwLock, mpsc},
    time::{Duration, Instant},
};

#[cfg(not(windows))]
use crossterm::event::{
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::{
    cursor::{Hide, Show},
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event,
    },
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen, SetTitle},
};
use nsh_core::{
    MountBatch,
    platform::{Appearance, Locale, Renderer},
};
use nsh_engine::{
    App, Bundle, ColorScheme, Engine, EngineConfig, EngineControl, Environment, Idiom, Limits,
    MountSink, Os, Root,
};
use ratatui::{
    backend::CrosstermBackend,
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::{Clear, Paragraph, Widget, Wrap},
};

pub use crate::image::AssetBase;
use crate::{
    CellMetrics, Surface, SurfaceEvent, TerminalTextEngine,
    image::AssetReader,
    services::{HostServices, ServiceManager, ServiceOutput, ServiceRequest},
};

static UI_SETS: RwLock<Option<Vec<nsh_core::element::Registry>>> = RwLock::new(None);

/// Sets the UI sets served by subsequently loaded apps. The default is
/// `nsh/base`; app-specific hosts call this before creating views.
pub fn set_ui_sets(sets: Vec<nsh_core::element::Registry>) {
    *UI_SETS.write().unwrap_or_else(|e| e.into_inner()) = Some(sets);
}

fn ui_sets() -> Vec<nsh_core::element::Registry> {
    UI_SETS
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| vec![nsh_base::registry()])
}

/// The app loaded by [`run_app`].
#[derive(Debug)]
pub enum AppSource {
    /// A native Rust root component.
    Rust(Root),
    /// A JavaScript bundle from trusted app resources or source code.
    Bundle(Box<Bundle>),
    /// A development server that pushes full bundles and hot updates.
    #[cfg(feature = "dev")]
    DevServer(String),
}

/// Configuration shared by an embedded [`AppView`] and [`run_app`].
#[derive(Debug, Clone)]
pub struct AppOptions {
    /// Log engine commit timings through the `log` facade.
    pub trace: bool,
    /// Location of bundled `asset:/` resources.
    pub asset_base: Option<AssetBase>,
    /// The application's reverse-domain identifier.
    pub app_id: String,
    /// The standalone terminal's title.
    pub title: String,
    /// Initial width and height in terminal columns and rows. Interactive
    /// runs use the terminal's actual size; headless scripts use this size.
    pub size: (u16, u16),
    /// Headless verification steps, for example
    /// `wait 100; key Tab; type Hello; shot screen.txt; quit`.
    pub script: Option<String>,
    /// Initial appearance, before an app selects its own.
    pub appearance: Appearance,
    /// Resource limits of a JavaScript app.
    pub limits: Limits,
    /// Native modules and UI sets available to this view's JS VMs. `None`
    /// uses [`set_ui_sets`]'s process default; `Some(Vec::new())` serves none.
    /// Reloads construct new values from the same registry factories.
    pub ui_sets: Option<Vec<nsh_core::element::Registry>>,
    /// Virtual point dimensions of one terminal cell.
    pub metrics: CellMetrics,
    /// Native terminal components available through `nsh/native`, scoped
    /// to this view and retained across app reloads.
    pub components: crate::native::Components,
    /// Requests reduced-motion presentation for navigation and layout.
    pub reduce_motion: bool,
    /// Where apps keep their data, each in `<dir>/<app id>` (`nsh.json`
    /// `"id"`, carried by the bundle or Rust root). `None` uses the system's
    /// data directory ([`nsh_engine::data_dir`]); an embedding host supplies
    /// its own directory, such as its data directory plus `/nsh`.
    pub data_dir: Option<PathBuf>,
    /// The app's storage (`nsh/storage`), overriding the `storage.json` in
    /// its directory of [`data_dir`](Self::data_dir).
    pub storage: Option<Arc<dyn nsh_engine::StorageBackend>>,
}

impl Default for AppOptions {
    fn default() -> Self {
        Self {
            trace: false,
            asset_base: None,
            app_id: "com.longbridge.nsh.host".into(),
            title: "Native Shell".into(),
            size: (120, 40),
            script: None,
            appearance: Appearance::System,
            limits: Limits::default(),
            ui_sets: None,
            metrics: CellMetrics::default(),
            components: Default::default(),
            reduce_motion: false,
            data_dir: None,
            storage: None,
        }
    }
}

enum EngineEvent {
    Batch(MountBatch),
    Error(String),
    Frame,
    Reload,
}

struct Sink(mpsc::Sender<EngineEvent>);

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(EngineEvent::Batch(batch));
    }
    fn report_error(&self, message: &str) {
        let _ = self.0.send(EngineEvent::Error(message.into()));
    }
    fn request_frame(&self) {
        let _ = self.0.send(EngineEvent::Frame);
    }
    fn hot_update_failed(&self) {
        let _ = self.0.send(EngineEvent::Reload);
    }
}

/// One independently running NSH app, rendered into a Ratatui buffer.
///
/// The embedding host owns its terminal, chooses the area to render and
/// routes only that area's events to the view. Call [`Self::poll`] each
/// host frame and [`Self::tick`] on animation frames. Dropping the view
/// stops and joins its engine; neither construction nor drop changes the
/// terminal mode.
pub struct AppView {
    surface: Surface,
    options: AppOptions,
    environment: Environment,
    host: nsh_engine::HostChannel,
    engine: Option<Engine>,
    receiver: Option<mpsc::Receiver<EngineEvent>>,
    network: Arc<dyn nsh_engine::Network>,
    assets: Arc<AssetsProvider>,
    frame_requested: bool,
    has_frame: bool,
    last_error: Option<String>,
    status: Option<String>,
    theme: Option<nsh_base::Theme>,
    image_protocol: Option<crate::ImageProtocol>,
    /// Last path sent to this engine; transport deduplication only.
    focus_path: Vec<nsh_core::NodeId>,
    services: Option<ServiceManager>,
    service_output: VecDeque<ServiceOutput>,
    #[cfg(feature = "dev")]
    dev: Option<DevSession>,
}

impl AppView {
    /// Creates an empty view at `options.size`, without taking terminal IO.
    pub fn new(options: AppOptions) -> Self {
        let mut surface = Surface::new(options.size.0, options.size.1, options.metrics);
        let environment = initial_environment(&options);
        surface.set_dark(environment.color_scheme == ColorScheme::Dark);
        surface.set_components(options.components.clone());
        surface.set_reduce_motion(options.reduce_motion);
        let assets = Arc::new(AssetsProvider(RwLock::new(options.asset_base.clone())));
        Self {
            surface,
            environment,
            host: nsh_engine::HostChannel::new(),
            options,
            engine: None,
            receiver: None,
            network: crate::net::network(),
            assets,
            frame_requested: false,
            has_frame: false,
            last_error: None,
            status: None,
            theme: None,
            image_protocol: None,
            focus_path: Vec::new(),
            services: None,
            service_output: VecDeque::new(),
            #[cfg(feature = "dev")]
            dev: None,
        }
    }

    /// The channel with the apps this view runs (`nsh/host`). Configure launch
    /// parameters and call handlers before loading, or send events while an
    /// app runs. Clones share this view's channel across subsequent loads.
    pub fn host(&self) -> nsh_engine::HostChannel {
        self.host.clone()
    }

    /// Runs `app`, replacing the current engine and retained views.
    pub fn load(&mut self, app: App) -> io::Result<()> {
        self.stop_engine();
        let mut surface = Surface::new(
            self.options.size.0,
            self.options.size.1,
            self.options.metrics,
        );
        surface.inherit_image_protocol(&mut self.surface);
        self.surface = surface;
        self.focus_path.clear();
        self.surface
            .set_dark(self.environment.color_scheme == ColorScheme::Dark);
        self.surface.set_components(self.options.components.clone());
        self.surface.set_reduce_motion(self.options.reduce_motion);
        self.surface.set_image_protocol(self.image_protocol);
        let access = match &app {
            App::Js(bundle) => bundle.policy.access(),
            App::Rust(_) => nsh_engine::Policy::default().access(),
        };
        let assets: Arc<dyn nsh_engine::Assets> = self.assets.clone();
        self.surface.set_assets(Some(assets.clone()));
        self.surface.set_access(access);
        self.surface.services.enabled = self.services.is_some();
        if let Some(services) = &self.services {
            services.reset(self.surface.access.clone());
        }
        let config = EngineConfig {
            viewport: self.surface.viewport(),
            trace: self.options.trace,
            network: Some(self.network.clone()),
            assets: Some(assets),
            environment: self.environment,
            // Pages supply their own header content on the terminal.
            header_heights: nsh_core::NO_NATIVE_HEADER,
            limits: self.options.limits,
            ui_sets: self.options.ui_sets.clone().unwrap_or_else(ui_sets),
            runtime: None,
            data_dir: self.options.data_dir.clone().or_else(nsh_engine::data_dir),
            storage: self.options.storage.clone(),
            host: self.host.clone(),
            ..EngineConfig::new(app)
        };
        let (tx, rx) = mpsc::channel();
        let metrics = self.options.metrics;
        let fonts = self.surface.fonts.clone();
        let theme = self.theme.clone();
        self.engine = Some(Engine::start_with(
            config,
            move || TerminalTextEngine::with_fonts(metrics, fonts),
            Sink(tx),
            move |control| {
                if let Some(theme) = theme {
                    control.set_tokens(Some(theme.into_tokens()));
                }
            },
        )?);
        self.receiver = Some(rx);
        self.last_error = None;
        self.has_frame = false;
        self.frame_requested = false;
        Ok(())
    }

    /// Starts a reconnecting dev-server session. Bundles and hot updates
    /// are applied by [`Self::poll`]. Ctrl+R reloads the latest full build.
    #[cfg(feature = "dev")]
    pub fn connect(&mut self, url: String) -> io::Result<()> {
        use nsh_dev::{DevClient, HostInfo, protocol::HostPlatform};
        self.stop();
        self.last_error = None;
        self.has_frame = false;
        let base = dev_asset_base(&url).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "a dev server URL must start with ws:// or wss:// and name a host",
            )
        })?;
        self.set_asset_base(Some(AssetBase::Http(base)));
        let host = HostInfo {
            device: "Terminal".into(),
            tests: false,
            platform: HostPlatform::Tui,
            bytecode_version: nsh_engine::BYTECODE_VERSION.into(),
            ui_sets: self
                .options
                .ui_sets
                .clone()
                .unwrap_or_else(ui_sets)
                .iter()
                .flat_map(nsh_core::element::Registry::sets)
                .filter_map(|set| set.specifier().map(str::to_owned))
                .collect(),
        };
        let (tx, rx) = mpsc::channel();
        let client = DevClient::start(url.clone(), host, move |event| {
            let _ = tx.send(event);
        })?;
        self.dev = Some(DevSession {
            client,
            receiver: rx,
            running: None,
            latest: None,
        });
        self.status = Some(format!("Connecting to {url}"));
        Ok(())
    }

    /// Applies queued engine batches and development updates without
    /// waiting for the engine. Returns whether the display changed.
    pub fn poll(&mut self) -> io::Result<bool> {
        let mut changed = false;
        #[cfg(feature = "dev")]
        {
            let events: Vec<_> = self
                .dev
                .as_ref()
                .map(|dev| dev.receiver.try_iter().collect())
                .unwrap_or_default();
            for event in events {
                self.dev_event(event)?;
                changed = true;
            }
        }
        let events: Vec<_> = self
            .receiver
            .as_ref()
            .map(|rx| rx.try_iter().collect())
            .unwrap_or_default();
        for event in events {
            match event {
                EngineEvent::Batch(batch) => {
                    self.surface.apply(batch);
                    self.has_frame = true;
                    changed = true;
                }
                EngineEvent::Error(message) => {
                    self.last_error = Some(message);
                    changed = true;
                }
                EngineEvent::Frame => self.frame_requested = true,
                EngineEvent::Reload => {
                    #[cfg(feature = "dev")]
                    self.reload_after_update()?;
                    // A reload replaced the receiver. Old-engine events
                    // collected above must never enter the new surface.
                    break;
                }
            }
        }
        self.dispatch_events();
        changed |= self.poll_services();
        #[cfg(feature = "dev")]
        if let Some(dev) = &self.dev {
            for record in take_logs() {
                let record = record.terminal_safe();
                dev.client
                    .log(record.level.into(), &record.target, &record.message);
            }
        }
        Ok(changed)
    }

    /// Advances native animations at monotonic time `now` in seconds and
    /// delivers requested animation frames to the engine.
    pub fn tick(&mut self, now: f64) -> io::Result<bool> {
        let mut changed = self.poll()?;
        changed |= self.surface.tick(now);
        self.dispatch_events();
        if self.frame_requested {
            self.frame_requested = false;
            if let Some(control) = self.control() {
                control.frame();
            }
        }
        Ok(changed)
    }

    /// Routes an event in coordinates local to this view. Embedders
    /// subtract the rendered area's origin from mouse coordinates first.
    pub fn handle_event(&mut self, event: Event) -> bool {
        if let Event::Resize(columns, rows) = event {
            self.resize(columns, rows);
            return true;
        }
        #[cfg(feature = "dev")]
        if let Event::Key(key) = &event
            && key.kind != event::KeyEventKind::Release
            && key.code == event::KeyCode::Char('r')
            && key.modifiers.contains(event::KeyModifiers::CONTROL)
            && self.dev.is_some()
        {
            if let Err(error) = self.reload_latest() {
                self.last_error = Some(error.to_string());
            }
            return true;
        }
        let changed = self.surface.handle_event(event);
        self.dispatch_events();
        changed
    }

    /// Updates this view's viewport in terminal columns and rows.
    pub fn resize(&mut self, columns: u16, rows: u16) {
        self.options.size = (columns, rows);
        self.surface.resize(columns, rows);
        let size = self.surface.viewport();
        self.environment.window = size;
        if let Some(control) = self.control() {
            self.publish_focus(&control);
            control.resize(size);
            control.set_environment(self.environment);
        }
    }

    /// Paints the retained scene, then any development status or error,
    /// clipped to `area`; terminal flushing remains the host's concern.
    pub fn render(&self, area: Rect, buffer: &mut Buffer) {
        if self.last_error.is_some() || self.status.is_some() {
            self.surface.render_plain(area, buffer);
        } else {
            self.surface.render(area, buffer);
        }
        if let Some(error) = &self.last_error {
            Clear.render(area, buffer);
            Paragraph::new(format!(
                "Native Shell\n\n{}\n\nCtrl+R reloads a development app. Ctrl+Q exits.",
                safe_diagnostic(error)
            ))
            .style(Style::default().fg(Color::Red))
            .wrap(Wrap { trim: false })
            .render(area, buffer);
        } else if let Some(status) = &self.status {
            let line = Rect::new(
                area.x,
                area.y.saturating_add(area.height.saturating_sub(1)),
                area.width,
                u16::from(area.height > 0),
            );
            Paragraph::new(safe_diagnostic(status))
                .style(Style::default().fg(Color::Yellow).bg(Color::Black))
                .render(line, buffer);
        }
    }

    /// Plain text of the current scene, suitable for snapshot checks.
    pub fn snapshot(&self) -> String {
        self.surface.snapshot()
    }

    /// The retained scene, for a host's own integration.
    pub fn surface(&self) -> &Surface {
        &self.surface
    }

    /// Mutably accesses the retained scene. [`Self::poll`] forwards its
    /// queued input events to the app.
    pub fn surface_mut(&mut self) -> &mut Surface {
        &mut self.surface
    }

    /// A cloneable handle to the current engine, or `None` before loading.
    pub fn control(&self) -> Option<EngineControl> {
        self.engine.as_ref().map(Engine::control)
    }

    /// The most recently reported app or build error, if any.
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// Sets where subsequently loaded app resources resolve. Images and
    /// engine resources in a running app use the new source too.
    pub fn set_asset_base(&mut self, base: Option<AssetBase>) {
        self.options.asset_base = base;
        *self.assets.0.write().unwrap_or_else(|e| e.into_inner()) = self.options.asset_base.clone();
        self.surface.set_assets(Some(self.assets.clone()));
    }

    /// Sets the host appearance. An app's explicit appearance still wins.
    pub fn set_appearance(&mut self, appearance: Appearance) {
        self.options.appearance = appearance;
        self.environment.color_scheme = appearance.resolve(ColorScheme::Dark);
        self.surface
            .set_dark(self.environment.color_scheme == ColorScheme::Dark);
        if let Some(control) = self.control() {
            self.publish_focus(&control);
            control.set_environment(self.environment);
        }
    }

    /// Applies a host theme now and to subsequently loaded apps. `None`
    /// restores the app's own theme.
    pub fn set_theme(&mut self, theme: Option<nsh_base::Theme>) {
        self.theme = theme.clone();
        if let Some(control) = self.control() {
            control.set_tokens(theme.map(nsh_base::Theme::into_tokens));
        }
    }

    /// Updates the host's reduced-motion preference for this app and
    /// subsequent reloads.
    pub fn set_reduce_motion(&mut self, reduce_motion: bool) {
        self.options.reduce_motion = reduce_motion;
        self.environment.reduce_motion = reduce_motion;
        self.surface.set_reduce_motion(reduce_motion);
        if let Some(control) = self.control() {
            self.publish_focus(&control);
            control.set_environment(self.environment);
        }
    }

    /// Supplies explicit host clipboard, title and accessibility transports.
    /// Callbacks run on one worker and persist across app reloads. `None`
    /// restores the local clipboard and stops pending host requests.
    pub fn set_host_services(&mut self, host: Option<Arc<dyn HostServices>>) -> io::Result<()> {
        self.services = host.map(ServiceManager::new).transpose()?;
        if let Some(services) = &self.services {
            services.reset(self.surface.access.clone());
        }
        self.surface.services.enabled = self.services.is_some();
        self.service_output.clear();
        Ok(())
    }

    /// Drains explicit terminal/assistive effects. Embedding hosts own their
    /// output transport; collecting these effects performs no terminal IO.
    pub fn drain_service_output(&mut self) -> impl Iterator<Item = ServiceOutput> + '_ {
        let clipboard = self.surface.access.allows_clipboard();
        self.service_output
            .drain(..)
            .filter(move |output| clipboard || !matches!(output, ServiceOutput::Clipboard(_)))
    }

    /// Semantic elements suitable for a host's accessibility bridge.
    pub fn accessibility_snapshot(&self) -> Vec<crate::services::AccessibleNode> {
        self.surface.accessibility_snapshot()
    }

    /// Enables a graphics protocol already selected by the embedding host,
    /// using that terminal's physical cell dimensions. This performs no
    /// terminal query and persists across app reloads. `None` restores the
    /// universal half-block renderer. Standalone interactive apps detect
    /// the protocol before starting their terminal event reader.
    pub fn set_image_protocol(&mut self, protocol: Option<crate::ImageProtocol>) {
        self.image_protocol = protocol;
        self.surface.set_image_protocol(protocol);
    }

    /// Returns terminal commands that release this view's graphics
    /// resources. The embedding host writes them before releasing its
    /// terminal; this method performs no IO. The standalone runner owns
    /// this cleanup through its terminal guard.
    pub fn image_protocol_cleanup(&self) -> String {
        self.surface.image_protocol_cleanup()
    }

    /// Registers a terminal component factory for subsequent mounts in
    /// this view, including after an app reload.
    pub fn register_component(
        &mut self,
        name: &str,
        factory: impl Fn() -> Box<dyn crate::native::NativeComponent> + Send + Sync + 'static,
    ) {
        self.options.components.register(name, factory);
        self.surface.set_components(self.options.components.clone());
    }

    /// Stops the current app and disconnects development support.
    pub fn stop(&mut self) {
        #[cfg(feature = "dev")]
        {
            self.dev = None;
        }
        self.stop_engine();
    }

    fn stop_engine(&mut self) {
        if let Some(services) = &self.services {
            services.reset(self.surface.access.clone());
        }
        self.service_output.clear();
        self.engine = None;
        self.receiver = None;
        self.frame_requested = false;
    }

    fn dispatch_events(&mut self) {
        let events: Vec<_> = self.surface.drain_events().collect();
        let Some(control) = self.control() else {
            return;
        };
        self.publish_focus(&control);
        for event in events {
            match event {
                SurfaceEvent::Event(id, kind, payload) => control.dispatch_event(id, kind, payload),
                SurfaceEvent::HintObservation(observation) => control.observe_hint(observation),
                SurfaceEvent::Scroll(id, offset, count) => control.scroll(id, offset, count),
                SurfaceEvent::ListCellRetired(id, request, retired) => {
                    control.set_focus_path(self.surface.focus_path());
                    control.retire_list_cell(id, request, retired);
                }
                SurfaceEvent::States(id, states) => control.set_states(id, states),
                SurfaceEvent::AnimationsFinished(finished) => control.animations_finished(finished),
                SurfaceEvent::ComponentSize(id, size) => control.set_component_size(id, size),
                SurfaceEvent::Zoom(id, scale) => control.zoom(id, scale),
                SurfaceEvent::RootSize(id, size, insets) => control.set_root_size(id, size, insets),
                SurfaceEvent::Service(request) => self.service_request(request),
            }
        }
    }

    fn publish_focus(&mut self, control: &EngineControl) {
        let path = self.surface.focus_path();
        if path != self.focus_path {
            control.set_focus_path(path.clone());
            self.focus_path = path;
        }
    }

    fn service_request(&mut self, request: ServiceRequest) {
        if let Some(services) = &self.services {
            services.sync_access(self.surface.access.clone());
            if let Err(request) = services.submit(request) {
                self.complete_service(request, Err("terminal service queue is full".into()));
            }
        } else {
            self.complete_service(request, Ok(None));
        }
    }

    fn poll_services(&mut self) -> bool {
        if let Some(services) = &self.services {
            services.sync_access(self.surface.access.clone());
        }
        let completed: Vec<_> = self
            .services
            .as_ref()
            .map(|services| services.poll().collect())
            .unwrap_or_default();
        let changed = !completed.is_empty();
        for completion in completed {
            self.complete_service(completion.request, completion.result);
        }
        self.dispatch_events();
        changed
    }

    fn complete_service(
        &mut self,
        request: ServiceRequest,
        result: Result<Option<crate::services::ClipboardContent>, String>,
    ) {
        match request {
            ServiceRequest::ClipboardRead { id, has_only } => self.surface.complete_clipboard(
                id,
                has_only,
                result.and_then(|value| {
                    value.ok_or_else(|| "host clipboard returned no result".into())
                }),
            ),
            ServiceRequest::ClipboardPaste(edit) => self.surface.complete_paste(
                edit,
                result.and_then(|value| {
                    value.ok_or_else(|| "host clipboard returned no result".into())
                }),
            ),
            ServiceRequest::ClipboardWrite(text) if self.surface.access.allows_clipboard() => self
                .service_output
                .push_back(ServiceOutput::Clipboard(text)),
            ServiceRequest::Title(title) => {
                self.service_output.push_back(ServiceOutput::Title(title))
            }
            ServiceRequest::Announce(text) => self
                .service_output
                .push_back(ServiceOutput::Announcement(text)),
            _ => {}
        }
        while self.service_output.len() > 256 {
            self.service_output.pop_front();
        }
    }

    pub(crate) fn has_frame(&self) -> bool {
        self.has_frame
    }
}

impl Drop for AppView {
    fn drop(&mut self) {
        // Stop callbacks and component tasks before the retained surface
        // releases its native components and graphical worker handles.
        self.stop();
        self.services = None;
    }
}

struct AssetsProvider(RwLock<Option<AssetBase>>);

impl nsh_engine::Assets for AssetsProvider {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        let base = self.0.read().unwrap_or_else(|e| e.into_inner()).clone();
        nsh_engine::Assets::read(&AssetReader(base), uri)
    }
}

#[cfg(feature = "dev")]
struct DevSession {
    client: nsh_dev::DevClient,
    receiver: mpsc::Receiver<nsh_dev::DevEvent>,
    running: Option<(u64, u64)>,
    latest: Option<(u64, u64, Bundle)>,
}

#[cfg(feature = "dev")]
impl AppView {
    fn dev_event(&mut self, event: nsh_dev::DevEvent) -> io::Result<()> {
        use nsh_dev::{DevEvent, protocol::BundleFormat};
        match event {
            // Terminal scripts drive this host directly; it does not have
            // the real-platform test agent that handles these messages.
            DevEvent::Testing
            | DevEvent::Root
            | DevEvent::Step { .. }
            | DevEvent::TestSetup { .. }
            | DevEvent::Fetch { .. } => {}
            DevEvent::Connected => self.status = None,
            DevEvent::Disconnected => {
                self.status = Some("Dev server disconnected; reconnecting".into())
            }
            DevEvent::Building => self.status = Some("Building".into()),
            DevEvent::BuildFailed(message) | DevEvent::CannotRun { message, .. } => {
                self.status = None;
                self.last_error = Some(message);
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
                let bundle = match format {
                    // SAFETY: this developer-selected server negotiated
                    // the bytecode version before compiling its bundle.
                    BundleFormat::Bytecode => unsafe { Bundle::bytecode(bytes) },
                    BundleFormat::Source => {
                        Bundle::source(String::from_utf8(bytes).map_err(io::Error::other)?)
                    }
                }
                .with_policy(nsh_engine::Policy::development())
                .with_app_id(app_id.as_deref())
                .with_capabilities_json(capabilities.as_deref())
                .map_err(io::Error::other)?;
                let bundle = match source_map {
                    Some(map) => bundle.with_source_map(map),
                    None => bundle,
                };
                self.options.limits =
                    Limits::development(limits.as_deref()).map_err(io::Error::other)?;
                let Some(dev) = &mut self.dev else {
                    return Ok(());
                };
                let already_applied = dev.running == Some((session, version));
                dev.latest = Some((session, version, bundle.clone()));
                dev.running = Some((session, version));
                self.status = None;
                if !already_applied {
                    self.load(App::Js(bundle))?;
                }
            }
            DevEvent::Patch {
                session,
                version,
                base,
                code,
                source_map,
            } => {
                if self
                    .dev
                    .as_ref()
                    .is_some_and(|dev| dev.running == Some((session, base)))
                    && let Some(control) = self.control()
                {
                    control.hot_update(nsh_engine::HotUpdate {
                        name: format!("hot-{version}.js"),
                        code,
                        source_map: source_map.map(Into::into),
                    });
                    if let Some(dev) = &mut self.dev {
                        dev.running = Some((session, version));
                    }
                    self.last_error = None;
                    self.status = None;
                }
            }
        }
        Ok(())
    }

    fn reload_latest(&mut self) -> io::Result<()> {
        let latest = self.dev.as_ref().and_then(|dev| dev.latest.clone());
        if let Some((session, version, bundle)) = latest {
            if let Some(dev) = &mut self.dev {
                dev.running = Some((session, version));
            }
            self.load(App::Js(bundle))?;
        }
        Ok(())
    }

    fn reload_after_update(&mut self) -> io::Result<()> {
        let Some(dev) = &mut self.dev else {
            return Ok(());
        };
        let running = dev.running.take();
        if dev
            .latest
            .as_ref()
            .is_some_and(|(session, version, _)| Some((*session, *version)) == running)
        {
            self.reload_latest()?;
        }
        Ok(())
    }
}

fn initial_environment(options: &AppOptions) -> Environment {
    let viewport = options.metrics.viewport(options.size.0, options.size.1);
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|key| {
            std::env::var(key)
                .ok()
                .and_then(|value| Locale::parse(&value))
        })
        .unwrap_or_default();
    Environment {
        window: viewport,
        renderer: Renderer::Terminal,
        fallback_key_bindings: true,
        color_scheme: options.appearance.resolve(ColorScheme::Dark),
        os: if cfg!(target_os = "windows") {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        },
        idiom: Idiom::Desktop,
        reduce_motion: options.reduce_motion,
        locale,
        ..Environment::default()
    }
}

fn safe_diagnostic(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t'))
        .collect()
}

#[cfg(feature = "dev")]
fn dev_asset_base(url: &str) -> Option<String> {
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("ws://") {
        ("http", rest)
    } else {
        ("https", url.strip_prefix("wss://")?)
    };
    let host = rest.split('/').next().filter(|host| !host.is_empty())?;
    Some(format!("{scheme}://{host}/assets/"))
}

/// Runs an app until Ctrl+Q or its quit command. Interactive mode
/// owns raw mode, the alternate screen, mouse capture and bracketed paste,
/// restoring them on every return or panic. A script runs headlessly and
/// writes only its requested snapshots; it also works with redirected IO.
/// Interactive startup queries image protocols and pixel cell dimensions
/// for at most 600 ms before reading input events. `NSH_IMAGE_PROTOCOL`
/// accepts `auto`, `halfblocks`, `kitty`, `sixel` or `iterm2`; `halfblocks`
/// skips the query. Scripts and embedded views keep the half-block default.
/// Returned errors retain their IO kind and strip terminal controls from
/// diagnostic text, including errors produced by app code during a script.
pub fn run_app(source: AppSource, options: AppOptions) -> io::Result<()> {
    run_inner(source, options)
        .map_err(|error| io::Error::new(error.kind(), safe_diagnostic(&error.to_string())))
}

fn run_inner(source: AppSource, options: AppOptions) -> io::Result<()> {
    let script = options
        .script
        .as_deref()
        .map(crate::script::Script::parse)
        .transpose()?;
    let mut view = AppView::new(options);
    let interactive = script.is_none();
    if interactive && (!io::stdin().is_terminal() || !io::stdout().is_terminal()) {
        return Err(io::Error::new(
            io::ErrorKind::NotConnected,
            "interactive NSH apps need a terminal; --script runs headlessly",
        ));
    }
    let signals = interactive.then(ShutdownSignals::new).transpose()?;
    let mut session = if interactive {
        Some(TerminalSession::enter(&view.options.title)?)
    } else {
        None
    };
    if interactive {
        // Query synchronously before either app code or Crossterm can
        // consume input; a timeout leaves no reader behind.
        view.set_image_protocol(terminal_graphics::detect());
        if let Some(session) = &mut session {
            session.graphics_cleanup = view.image_protocol_cleanup();
        }
        view.set_host_services(Some(Arc::new(crate::services::SystemServices::default())))?;
    }
    match source {
        AppSource::Rust(root) => view.load(App::Rust(root))?,
        AppSource::Bundle(bundle) => view.load(App::Js(*bundle))?,
        #[cfg(feature = "dev")]
        AppSource::DevServer(url) => view.connect(url)?,
    }
    if let Some(script) = script {
        return crate::script::run(&mut view, script);
    }
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = ratatui::Terminal::new(backend)?;
    let (columns, rows) = terminal::size()?;
    view.resize(columns, rows);
    let started = Instant::now();
    let tmux = terminal_graphics::tmux();
    let mut dirty = true;
    while !view.surface.should_quit() && !signals.as_ref().is_some_and(ShutdownSignals::requested) {
        dirty |= view.tick(started.elapsed().as_secs_f64())?;
        let output: Vec<_> = view.drain_service_output().collect();
        if !output.is_empty() {
            let mut stdout = io::stdout().lock();
            for effect in output {
                stdout.write_all(effect.terminal_sequence(tmux).as_bytes())?;
            }
            stdout.flush()?;
        }
        if dirty {
            terminal.draw(|frame| view.render(frame.area(), frame.buffer_mut()))?;
            dirty = false;
        }
        if event::poll(Duration::from_millis(16))? {
            dirty |= view.handle_event(event::read()?);
        }
    }
    // Local drop order restores the terminal before joining the engine:
    // an app task finishing IO must not hold raw mode open on shutdown.
    Ok(())
}

/// Capability queries own stdin only during standalone startup. The
/// upstream convenience query leaves a background reader after a timeout;
/// polling here makes the deadline and transfer to Crossterm explicit.
mod terminal_graphics {
    use std::{
        io::{self, Write},
        time::{Duration, Instant},
    };

    use ratatui_image::picker::cap_parser::{Parser, QueryStdioOptions, Response};

    use crate::{ImageProtocol, ProtocolType};

    const QUERY_TIMEOUT: Duration = Duration::from_millis(600);

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Preference {
        Auto,
        Halfblocks,
        Forced(ProtocolType),
    }

    impl Preference {
        fn parse(value: Option<&str>) -> Self {
            match value.unwrap_or("auto").trim().to_ascii_lowercase().as_str() {
                "auto" => Self::Auto,
                "halfblocks" => Self::Halfblocks,
                "kitty" => Self::Forced(ProtocolType::Kitty),
                "sixel" => Self::Forced(ProtocolType::Sixel),
                "iterm2" => Self::Forced(ProtocolType::Iterm2),
                _ => {
                    log::warn!("unknown NSH_IMAGE_PROTOCOL; using auto detection");
                    Self::Auto
                }
            }
        }
    }

    pub(super) fn detect() -> Option<ImageProtocol> {
        let preference = Preference::parse(std::env::var("NSH_IMAGE_PROTOCOL").ok().as_deref());
        if preference == Preference::Halfblocks
            || (preference == Preference::Auto
                && std::env::var("TERM").is_ok_and(|term| term == "dumb"))
        {
            return None;
        }
        let term = std::env::var("TERM").ok();
        let program = std::env::var("TERM_PROGRAM").ok();
        let tmux_session = std::env::var("TMUX").ok();
        let tmux = tmux_hint(term.as_deref(), program.as_deref(), tmux_session.as_deref());
        let blacklist = preference == Preference::Auto
            && ["WEZTERM_EXECUTABLE", "KONSOLE_VERSION"]
                .into_iter()
                .any(|key| std::env::var(key).is_ok_and(|value| !value.is_empty()));
        let options = QueryStdioOptions {
            timeout: QUERY_TIMEOUT,
            blacklist_protocols: if blacklist {
                vec![ProtocolType::Kitty, ProtocolType::Sixel]
            } else {
                Vec::new()
            },
            ..QueryStdioOptions::default()
        };
        let responses = match query(&Parser::query(tmux, options)) {
            Ok(responses) => responses,
            Err(error) => {
                log::debug!("terminal graphics query failed: {error}");
                Vec::new()
            }
        };
        let iterm2 = std::env::var("TERM_PROGRAM").is_ok_and(|program| iterm2_hint(&program))
            || std::env::var("LC_TERMINAL").is_ok_and(|program| program.contains("iTerm"))
            || (tmux
                && ["ITERM_SESSION_ID", "WEZTERM_EXECUTABLE"]
                    .into_iter()
                    .any(|key| std::env::var(key).is_ok_and(|value| !value.is_empty())));
        resolve(&responses, preference, fallback_cell_size(), tmux, iterm2)
    }

    fn iterm2_hint(program: &str) -> bool {
        [
            "iTerm",
            "WezTerm",
            "mintty",
            "vscode",
            "Tabby",
            "Hyper",
            "rio",
            "Bobcat",
            "WarpTerminal",
        ]
        .into_iter()
        .any(|name| program.contains(name))
    }

    fn tmux_hint(term: Option<&str>, program: Option<&str>, session: Option<&str>) -> bool {
        term.is_some_and(|term| term.starts_with("tmux"))
            || program == Some("tmux")
            || session.is_some_and(|session| !session.is_empty())
    }

    pub(super) fn tmux() -> bool {
        tmux_hint(
            std::env::var("TERM").ok().as_deref(),
            std::env::var("TERM_PROGRAM").ok().as_deref(),
            std::env::var("TMUX").ok().as_deref(),
        )
    }

    fn resolve(
        responses: &[Response],
        preference: Preference,
        fallback: Option<(u16, u16)>,
        tmux: bool,
        iterm2: bool,
    ) -> Option<ImageProtocol> {
        let cells = responses
            .iter()
            .rev()
            .find_map(|response| match response {
                Response::CellSize(Some((width, height))) if *width > 0 && *height > 0 => {
                    Some((*width, *height))
                }
                _ => None,
            })
            .or(fallback)?;
        let protocol = match preference {
            Preference::Halfblocks => return None,
            Preference::Forced(protocol) => protocol,
            Preference::Auto if responses.contains(&Response::Kitty) => ProtocolType::Kitty,
            Preference::Auto if responses.contains(&Response::Sixel) => ProtocolType::Sixel,
            Preference::Auto if iterm2 && (!tmux || responses.contains(&Response::Status)) => {
                ProtocolType::Iterm2
            }
            Preference::Auto => return None,
        };
        ImageProtocol::new(protocol, cells.0, cells.1)
            .ok()
            .map(|protocol| protocol.with_tmux(tmux))
    }

    fn query(request: &str) -> io::Result<Vec<Response>> {
        let mut output = io::stdout().lock();
        output.write_all(request.as_bytes())?;
        output.flush()?;
        let deadline = Instant::now() + QUERY_TIMEOUT;
        let mut parser = Parser::new();
        let mut responses = Vec::new();
        // The byte budget also bounds parser memory for a terminal that
        // sends incomplete or unsolicited sequences during the probe.
        for _ in 0..16_384 {
            let Some(byte) = read_byte(deadline)? else {
                break;
            };
            let parsed = parser.push(char::from(byte));
            let done = parsed.contains(&Response::Status);
            responses.extend(parsed);
            if done {
                break;
            }
        }
        Ok(responses)
    }

    #[cfg(unix)]
    fn read_byte(deadline: Instant) -> io::Result<Option<u8>> {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            let mut poll = libc::pollfd {
                fd: libc::STDIN_FILENO,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: poll points to one initialized descriptor and the
            // deadline is bounded. No other terminal reader has started.
            let ready = unsafe {
                libc::poll(
                    &mut poll,
                    1,
                    remaining.as_millis().max(1).min(i32::MAX as u128) as i32,
                )
            };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if ready == 0 || poll.revents & libc::POLLIN == 0 {
                return Ok(None);
            }
            let mut byte = 0u8;
            // SAFETY: poll established readable stdin and byte is a valid
            // one-byte destination. The probe is the sole input reader.
            let count = unsafe { libc::read(libc::STDIN_FILENO, (&mut byte as *mut u8).cast(), 1) };
            if count == 1 {
                return Ok(Some(byte));
            }
            if count == 0 {
                return Ok(None);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    #[cfg(windows)]
    fn read_byte(deadline: Instant) -> io::Result<Option<u8>> {
        use windows_sys::Win32::System::Console::{
            GetNumberOfConsoleInputEvents, GetStdHandle, INPUT_RECORD, KEY_EVENT,
            ReadConsoleInputW, STD_INPUT_HANDLE,
        };
        // SAFETY: reads this process's existing console handle without
        // taking ownership. The interactive runner verified terminal IO.
        let input = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        while Instant::now() < deadline {
            let mut pending = 0;
            // SAFETY: input is the current console and pending is writable.
            if unsafe { GetNumberOfConsoleInputEvents(input, &mut pending) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if pending == 0 {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            let mut record = std::mem::MaybeUninit::<INPUT_RECORD>::uninit();
            let mut count = 0;
            // SAFETY: a queued record exists, the output covers one record,
            // and no Crossterm event reader has started to compete for it.
            if unsafe { ReadConsoleInputW(input, record.as_mut_ptr(), 1, &mut count) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if count == 0 {
                continue;
            }
            // SAFETY: ReadConsoleInputW initialized the single record above.
            let record = unsafe { record.assume_init() };
            if u32::from(record.EventType) != KEY_EVENT {
                continue;
            }
            // SAFETY: EventType selects the KeyEvent union member.
            let key = unsafe { record.Event.KeyEvent };
            if key.bKeyDown == 0 {
                continue;
            }
            // SAFETY: KEY_EVENT_RECORD's UnicodeChar member is valid for
            // ReadConsoleInputW. Capability responses contain ASCII only.
            let character = unsafe { key.uChar.UnicodeChar };
            if let Ok(byte) = u8::try_from(character) {
                return Ok(Some(byte));
            }
        }
        Ok(None)
    }

    #[cfg(not(any(unix, windows)))]
    fn read_byte(_: Instant) -> io::Result<Option<u8>> {
        Ok(None)
    }

    #[cfg(unix)]
    fn fallback_cell_size() -> Option<(u16, u16)> {
        let size = crossterm::terminal::window_size().ok()?;
        if size.columns == 0 || size.rows == 0 {
            return None;
        }
        let cell = (size.width / size.columns, size.height / size.rows);
        (cell.0 > 0 && cell.1 > 0).then_some(cell)
    }

    #[cfg(windows)]
    fn fallback_cell_size() -> Option<(u16, u16)> {
        use windows_sys::Win32::System::Console::{
            CONSOLE_FONT_INFOEX, GetCurrentConsoleFontEx, GetStdHandle, STD_OUTPUT_HANDLE,
        };
        let mut font = CONSOLE_FONT_INFOEX {
            cbSize: std::mem::size_of::<CONSOLE_FONT_INFOEX>() as u32,
            ..Default::default()
        };
        // SAFETY: retrieves the process's output handle without owning it;
        // font is initialized with the size required by the console API.
        if unsafe { GetCurrentConsoleFontEx(GetStdHandle(STD_OUTPUT_HANDLE), 0, &mut font) } == 0 {
            return None;
        }
        let cell = (
            u16::try_from(font.dwFontSize.X).ok()?,
            u16::try_from(font.dwFontSize.Y).ok()?,
        );
        (cell.0 > 0 && cell.1 > 0).then_some(cell)
    }

    #[cfg(not(any(unix, windows)))]
    fn fallback_cell_size() -> Option<(u16, u16)> {
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn responses(bytes: &str) -> Vec<Response> {
            let mut parser = Parser::new();
            bytes.chars().flat_map(|ch| parser.push(ch)).collect()
        }

        #[test]
        fn startup_probe_prefers_reported_kitty_then_sixel_and_exact_cells() {
            let replies =
                responses("\u{1b}_Gi=31;OK\u{1b}\\\u{1b}[?1;2;4c\u{1b}[6;20;10t\u{1b}[0n");
            let protocol = resolve(&replies, Preference::Auto, Some((8, 16)), false, true).unwrap();
            assert_eq!(protocol.protocol_type(), ProtocolType::Kitty);
            assert_eq!(protocol.cell_size(), (10, 20));
            let sixel = resolve(
                &responses("\u{1b}[?1;2;4c\u{1b}[6;18;9t\u{1b}[0n"),
                Preference::Auto,
                None,
                false,
                false,
            )
            .unwrap();
            assert_eq!(sixel.protocol_type(), ProtocolType::Sixel);
            assert_eq!(sixel.cell_size(), (9, 18));
        }

        #[test]
        fn protocols_require_real_cell_dimensions_and_tmux_passthrough_evidence() {
            assert!(resolve(&[Response::Kitty], Preference::Auto, None, false, false).is_none());
            assert!(resolve(&[], Preference::Auto, Some((8, 16)), false, false).is_none());
            assert!(resolve(&[], Preference::Auto, Some((8, 16)), true, true).is_none());
            assert_eq!(
                resolve(
                    &[Response::Status],
                    Preference::Auto,
                    Some((8, 16)),
                    true,
                    true
                )
                .unwrap()
                .protocol_type(),
                ProtocolType::Iterm2
            );
            assert!(
                resolve(
                    &[Response::Kitty],
                    Preference::Halfblocks,
                    Some((8, 16)),
                    false,
                    false
                )
                .is_none()
            );
            assert_eq!(
                Preference::parse(Some("halfblocks")),
                Preference::Halfblocks
            );
            assert!(tmux_hint(
                Some("screen-256color"),
                Some("iTerm.app"),
                Some("/tmp/tmux-1000/default,123,0")
            ));
            assert!(!tmux_hint(Some("screen-256color"), Some("iTerm.app"), None));
        }
    }
}

struct TerminalSession {
    graphics_cleanup: String,
    #[cfg(not(windows))]
    keyboard_enhanced: bool,
}

impl TerminalSession {
    fn enter(title: &str) -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        // Construct the guard first: a partial setup also needs restoring.
        let session = Self {
            graphics_cleanup: String::new(),
            #[cfg(not(windows))]
            keyboard_enhanced: false,
        };
        #[cfg(not(windows))]
        let mut session = session;
        // An app title is data inside an OSC sequence. Strip terminal
        // controls so a package title cannot inject another sequence.
        let title: String = title.chars().filter(|ch| !ch.is_control()).collect();
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            EnableMouseCapture,
            EnableBracketedPaste,
            Hide,
            SetTitle(title)
        )?;
        // The Windows backend receives native console key records; its
        // Crossterm transport cannot decode CSI-u keyboard events.
        #[cfg(not(windows))]
        {
            session.keyboard_enhanced = true;
            execute!(
                io::stdout(),
                PushKeyboardEnhancementFlags(
                    KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                        | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                        | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
                )
            )?;
        }
        Ok(session)
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = io::stdout().write_all(self.graphics_cleanup.as_bytes());
        #[cfg(not(windows))]
        if self.keyboard_enhanced {
            let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
        }
        let _ = execute!(
            io::stdout(),
            Show,
            DisableBracketedPaste,
            DisableMouseCapture,
            LeaveAlternateScreen
        );
        let _ = terminal::disable_raw_mode();
    }
}

struct ShutdownSignals {
    #[cfg(not(windows))]
    requested: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(unix)]
    registrations: Vec<signal_hook::SigId>,
}

impl ShutdownSignals {
    fn new() -> io::Result<Self> {
        #[cfg(not(windows))]
        let requested = Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(unix)]
        {
            let mut registrations = Vec::new();
            for signal in [
                signal_hook::consts::SIGINT,
                signal_hook::consts::SIGTERM,
                signal_hook::consts::SIGHUP,
            ] {
                match signal_hook::flag::register(signal, requested.clone()) {
                    Ok(id) => registrations.push(id),
                    Err(error) => {
                        for id in registrations {
                            signal_hook::low_level::unregister(id);
                        }
                        return Err(error);
                    }
                }
            }
            Ok(Self {
                requested,
                registrations,
            })
        }
        #[cfg(windows)]
        {
            CONSOLE_STOP.store(false, std::sync::atomic::Ordering::Relaxed);
            // SAFETY: the handler lives for the process and only writes
            // an atomic flag. Drop unregisters this exact handler.
            if unsafe {
                windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(console_stop), 1)
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {})
        }
        #[cfg(not(any(unix, windows)))]
        Ok(Self { requested })
    }

    fn requested(&self) -> bool {
        #[cfg(windows)]
        {
            CONSOLE_STOP.load(std::sync::atomic::Ordering::Relaxed)
        }
        #[cfg(not(windows))]
        self.requested.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(windows)]
static CONSOLE_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
unsafe extern "system" fn console_stop(event: u32) -> windows_sys::core::BOOL {
    use windows_sys::Win32::System::Console::{
        CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
    };
    if matches!(
        event,
        CTRL_C_EVENT
            | CTRL_BREAK_EVENT
            | CTRL_CLOSE_EVENT
            | CTRL_LOGOFF_EVENT
            | CTRL_SHUTDOWN_EVENT
    ) {
        CONSOLE_STOP.store(true, std::sync::atomic::Ordering::Relaxed);
        1
    } else {
        0
    }
}

#[cfg(windows)]
impl Drop for ShutdownSignals {
    fn drop(&mut self) {
        // SAFETY: removes the same process-static handler registered in new.
        unsafe {
            windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(console_stop), 0);
        }
    }
}

#[cfg(unix)]
impl Drop for ShutdownSignals {
    fn drop(&mut self) {
        for id in self.registrations.drain(..) {
            signal_hook::low_level::unregister(id);
        }
    }
}

#[cfg(feature = "dev")]
struct LogRecord {
    level: log::Level,
    target: String,
    message: String,
}

#[cfg(feature = "dev")]
impl LogRecord {
    fn terminal_safe(mut self) -> Self {
        self.target = safe_diagnostic(&self.target);
        self.message = safe_diagnostic(&self.message);
        self
    }
}
#[cfg(feature = "dev")]
static LOGS: Mutex<VecDeque<LogRecord>> = Mutex::new(VecDeque::new());

/// Installs the standalone hosts' logger. Diagnostics are buffered and
/// forwarded to a connected dev server; setting `NSH_LOG` additionally
/// writes them to that file. Output strips terminal control characters
/// while retaining newlines and tabs. No log line writes over the scene.
/// Embedders keep their own logger instead.
pub fn init_logging() {
    struct Logger;
    impl log::Log for Logger {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            let message = record.args().to_string();
            if let Ok(path) = std::env::var("NSH_LOG")
                && let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
            {
                let _ = writeln!(
                    file,
                    "{} {}: {}",
                    record.level(),
                    safe_diagnostic(record.target()),
                    safe_diagnostic(&message)
                );
            }
            #[cfg(feature = "dev")]
            {
                let mut logs = LOGS.lock().unwrap_or_else(|e| e.into_inner());
                if logs.len() >= 1024 {
                    logs.pop_front();
                }
                logs.push_back(LogRecord {
                    level: record.level(),
                    target: record.target().into(),
                    message,
                });
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Logger = Logger;
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

#[cfg(feature = "dev")]
fn take_logs() -> Vec<LogRecord> {
    LOGS.lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain(..)
        .collect()
}

#[cfg(test)]
mod tests {
    use nsh_base::input;
    use nsh_core::prelude::*;

    use super::*;

    #[component]
    fn PlainInputFocusProbe() -> impl IntoElement {
        let value = signal(String::new());
        let focused = signal(false);
        view()
            .flex_col()
            .child(
                input()
                    .label("Focus probe input")
                    .auto_focus(true)
                    .h(px(32.0))
                    .on_focus(move || focused.set(true))
                    .on_change(move |text: &str| value.set(text.to_owned())),
            )
            .child(text(move || {
                format!("Probe focused:{} value:{}", focused.get(), value.get())
            }))
    }

    #[component]
    fn CodeEditorFocusProbe() -> impl IntoElement {
        let value = signal(String::new());
        let focused = signal(false);
        view()
            .flex_col()
            .child(
                nsh_base::editor::editor()
                    .accessibility_label("Focus probe input")
                    .auto_focus(true)
                    .w(px(400.0))
                    .h(px(160.0))
                    .on_focus(move || focused.set(true))
                    .on_change(move |text: &SharedString| value.set(text.to_string())),
            )
            .child(text(move || {
                format!("Probe focused:{} value:{}", focused.get(), value.get())
            }))
    }

    #[test]
    fn code_editor_autofocus_reaches_its_native_sink_like_an_ordinary_input() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        use nsh_core::ViewKind;

        fn settle(view: &mut AppView) {
            view.poll().unwrap();
            let (tx, rx) = mpsc::channel();
            view.control()
                .unwrap()
                .advance_clock(Duration::ZERO, move || tx.send(()).unwrap());
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
            view.poll().unwrap();
        }
        fn wait(view: &mut AppView, ready: impl Fn(&AppView) -> bool, stage: &str) {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                settle(view);
                if ready(view) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "{stage}: {:?}\n{}",
                    view.last_error(),
                    view.snapshot()
                );
            }
        }
        for editor in [false, true] {
            let app: App = if editor {
                Root::of::<CodeEditorFocusProbe>().into()
            } else {
                Root::of::<PlainInputFocusProbe>().into()
            };
            let mut view = AppView::new(AppOptions::default());
            view.load(app).unwrap();
            let sink = |view: &AppView| {
                view.accessibility_snapshot()
                    .into_iter()
                    .find(|node| {
                        node.label == "Focus probe input"
                            && view
                                .surface()
                                .node(node.id)
                                .is_some_and(|n| n.kind == ViewKind::Input)
                    })
                    .map(|node| node.id)
            };
            // Readiness comes from the real mounted Input and rendered callback state,
            // not a guessed frame count, direct Surface focus assignment or a click.
            wait(
                &mut view,
                |view| sink(view).is_some() && view.snapshot().contains("Probe focused:"),
                "probe did not mount",
            );
            let id = sink(&view).unwrap();
            wait(
                &mut view,
                |view| {
                    view.surface().focused() == Some(id)
                        && view.snapshot().contains("Probe focused:true")
                },
                if editor {
                    "code Editor autofocus did not reach its native sink"
                } else {
                    "ordinary Input control autofocus failed"
                },
            );
            view.handle_event(crossterm::event::Event::Key(KeyEvent::new(
                KeyCode::Char('x'),
                KeyModifiers::NONE,
            )));
            wait(
                &mut view,
                |view| view.snapshot().contains("Probe focused:true value:x"),
                if editor {
                    "code Editor did not receive native typing"
                } else {
                    "ordinary Input control did not receive native typing"
                },
            );
            if editor {
                let surface = view.surface();
                let frame = surface.global_frame(id).unwrap();
                let x = frame.origin.x.0 + frame.size.width.0 / 2.0;
                let y = frame.origin.y.0 + frame.size.height.0 / 2.0;
                let hit = surface.hit_test(x, y);
                assert!(
                    hit.is_some(),
                    "content beneath the sink remains a pointer target"
                );
                assert_ne!(hit, Some(id), "the native sink must not steal row presses");
            }
            view.stop();
        }
    }

    #[component]
    fn RichEditorFocusProbe() -> impl IntoElement {
        use nsh_base::rich_editor::{
            extensions::starter,
            state::{EditorState, EditorStateConfig},
            view::{EditorSession, NodeViews, RichEditorChange, rich_editor},
        };

        let state = EditorState::create(EditorStateConfig::new(starter::schema())).unwrap();
        let session = EditorSession::new(state, NodeViews::default());
        let changed = session.clone();
        let value = signal(String::new());
        let focused = signal(false);
        view()
            .flex_col()
            .child(
                rich_editor()
                    .editor(session)
                    .accessibility_label("Focus probe input")
                    .auto_focus(true)
                    .w(px(400.0))
                    .h(px(160.0))
                    .on_focus(move || focused.set(true))
                    .on_change(move |_: &RichEditorChange| {
                        value.set(changed.state().doc().text_content());
                    }),
            )
            .child(text(move || {
                format!("Probe focused:{} value:{}", focused.get(), value.get())
            }))
    }

    #[test]
    fn rich_editor_autofocus_reaches_its_native_sink_like_an_ordinary_input() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        use nsh_core::ViewKind;

        fn settle(view: &mut AppView) {
            view.poll().unwrap();
            let (tx, rx) = mpsc::channel();
            view.control()
                .unwrap()
                .advance_clock(Duration::ZERO, move || tx.send(()).unwrap());
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
            view.poll().unwrap();
        }
        fn wait(view: &mut AppView, ready: impl Fn(&AppView) -> bool, stage: &str) {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                settle(view);
                if ready(view) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "{stage}: focused={:?}, error={:?}\n{}",
                    view.surface().focused(),
                    view.last_error(),
                    view.snapshot()
                );
            }
        }
        for editor in [false, true] {
            let app: App = if editor {
                Root::of::<RichEditorFocusProbe>().into()
            } else {
                Root::of::<PlainInputFocusProbe>().into()
            };
            let mut view = AppView::new(AppOptions::default());
            view.load(app).unwrap();
            let sink = |view: &AppView| {
                view.accessibility_snapshot()
                    .into_iter()
                    .find(|node| {
                        node.label == "Focus probe input"
                            && view
                                .surface()
                                .node(node.id)
                                .is_some_and(|n| n.kind == ViewKind::Input)
                    })
                    .map(|node| node.id)
            };
            // Readiness comes from the real mounted Input and rendered callback state,
            // not a guessed frame count, direct Surface focus assignment or a click.
            wait(
                &mut view,
                |view| sink(view).is_some() && view.snapshot().contains("Probe focused:"),
                "probe did not mount",
            );
            let id = sink(&view).unwrap();
            wait(
                &mut view,
                |view| {
                    view.surface().focused() == Some(id)
                        && view.snapshot().contains("Probe focused:true")
                },
                if editor {
                    "RichEditor autofocus did not reach its native sink"
                } else {
                    "ordinary Input control autofocus failed"
                },
            );
            view.handle_event(crossterm::event::Event::Key(KeyEvent::new(
                KeyCode::Char('x'),
                KeyModifiers::NONE,
            )));
            wait(
                &mut view,
                |view| view.snapshot().contains("Probe focused:true value:x"),
                if editor {
                    "RichEditor did not receive native typing"
                } else {
                    "ordinary Input control did not receive native typing"
                },
            );
            view.stop();
        }
    }

    #[cfg(feature = "js")]
    #[class]
    struct ScopedHost {
        label: String,
        count: u32,
        closed: Arc<std::sync::atomic::AtomicBool>,
    }

    #[cfg(feature = "js")]
    #[class]
    impl ScopedHost {
        pub(crate) async fn query(this: Instance<Self>) -> Result<String, String> {
            this.with_mut(|host| {
                if host.closed.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("owner closed".into());
                }
                host.count += 1;
                Ok(format!("{}:{}", host.label, host.count))
            })
        }
    }

    #[cfg(feature = "js")]
    #[test]
    fn embedded_views_receive_their_own_host_objects_and_reload_them() {
        use std::sync::atomic::{AtomicBool, Ordering};

        use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
        let (created, creations) = mpsc::channel();
        let closed = Arc::new(AtomicBool::new(false));
        let options = |label: &str| {
            let (label, created, closed) = (label.to_owned(), created.clone(), closed.clone());
            let mut registry = nsh_core::element::Registry::ui_set("test/host");
            registry.value("host", move || {
                created.send(std::thread::current().id()).unwrap();
                Instance::new(ScopedHost {
                    label: label.clone(),
                    count: 0,
                    closed: closed.clone(),
                })
            });
            let declarations = nsh_core::element::declarations(&registry, &[]);
            assert!(declarations.contains("export declare const host: ScopedHost;"));
            assert!(declarations.contains("private constructor();"));
            AppOptions {
                ui_sets: Some(vec![registry]),
                ..Default::default()
            }
        };
        let app = || {
            App::Js(Bundle::source(
                r#"
            import { host, ScopedHost } from 'test/host';
            import { mount, Text, signal } from 'nsh';
            import { keymap } from 'nsh';
            let result = signal('loading');
            try { new ScopedHost(); throw Error('constructor exposed'); } catch(e) {
                if (e.message === 'constructor exposed') throw e;
            }
            mount(() => Text({children: () => result()}));
            keymap.bind('ctrl+x', async () => {
                try { result.set(await host.query()); } catch(e) { result.set(e.message); }
            });
            (async () => {
                await host.query();
                result.set(await host.query());
            })();
        "#
                .into(),
            ))
        };
        let wait = |view: &mut AppView, expected: &str| {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                view.poll().unwrap();
                if view.snapshot().contains(expected) {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "{} / {:?}",
                    view.snapshot(),
                    view.last_error()
                );
                std::thread::sleep(Duration::from_millis(2));
            }
        };
        let mut left = AppView::new(options("left"));
        let mut right = AppView::new(options("right"));
        left.load(app()).unwrap();
        right.load(app()).unwrap();
        wait(&mut left, "left:2");
        wait(&mut right, "right:2");
        left.load(app()).unwrap();
        wait(&mut left, "left:2");
        for _ in 0..3 {
            assert_ne!(
                creations.recv_timeout(Duration::from_secs(1)).unwrap(),
                std::thread::current().id()
            );
        }
        closed.store(true, Ordering::SeqCst);
        for view in [&mut left, &mut right] {
            view.handle_event(Event::Key(KeyEvent::new(
                KeyCode::Char('x'),
                KeyModifiers::CONTROL,
            )));
        }
        wait(&mut left, "owner closed");
        wait(&mut right, "owner closed");
        let mut unbound = AppView::new(AppOptions {
            ui_sets: Some(vec![]),
            ..Default::default()
        });
        unbound.load(app()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while unbound.last_error().is_none() {
            unbound.poll().unwrap();
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(unbound.last_error().unwrap().contains("test/host"));
    }

    #[component]
    fn ScriptApp() -> impl IntoElement {
        let typed = signal(String::new());
        let count = signal(0_u32);
        view()
            .flex_col()
            .child(text("Ready"))
            .child(
                input()
                    .h(px(32.0))
                    .value(move || typed.get())
                    .on_change(move |value: &str| typed.set(value.to_owned())),
            )
            .child(text(move || format!("Echo:{}", typed.get())))
            .child(
                view()
                    .h(px(32.0))
                    .on_press(move |_: &()| count.update(|value| *value += 1))
                    .child(text("Increment")),
            )
            .child(text(move || format!("Count:{}", count.get())))
    }

    #[component]
    fn ReparentedTouchApp() -> impl IntoElement {
        let phases = signal([0_u32; 4]);
        view()
            .flex_col()
            .child(text(move || {
                let counts = phases.get();
                format!(
                    "Touch phases:{}/{}/{}/{}",
                    counts[0], counts[1], counts[2], counts[3]
                )
            }))
            .child(
                view()
                    .label("Touch owner A")
                    .h(px(32.0))
                    .on_touch(move |touch: &nsh_core::TouchEvent| {
                        let phase = match touch.phase {
                            nsh_core::TouchPhase::Start => 0,
                            nsh_core::TouchPhase::Move => 1,
                            nsh_core::TouchPhase::End => 2,
                            nsh_core::TouchPhase::Cancel => 3,
                        };
                        phases.update(|counts| counts[phase] += 1);
                    })
                    .child(view().label("Touch hit X").h(px(32.0))),
            )
            .child(view().label("Touch destination B").h(px(64.0)))
    }

    #[test]
    fn admitted_touches_keep_their_owner_after_native_reparenting_until_end_or_retirement() {
        use crossterm::event::{Event, MouseButton, MouseEvent, MouseEventKind};
        use nsh_core::{EventMask, MountItem};

        fn flush(view: &mut AppView) {
            view.poll().unwrap();
            let (tx, rx) = mpsc::channel();
            view.control()
                .unwrap()
                .advance_clock(Duration::ZERO, move || tx.send(()).unwrap());
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
            view.poll().unwrap();
        }
        fn wait(view: &mut AppView, expected: &str) {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                flush(view);
                if view.snapshot().contains(expected) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "touch handler did not report {expected}: {:?}\n{}",
                    view.last_error(),
                    view.snapshot()
                );
            }
        }

        for retire in [false, true] {
            let mut view = AppView::new(AppOptions {
                size: (80, 24),
                ..Default::default()
            });
            view.load(Root::of::<ReparentedTouchApp>().into()).unwrap();
            wait(&mut view, "Touch phases:0/0/0/0");
            let target = |label: &str| {
                view.accessibility_snapshot()
                    .into_iter()
                    .find(|node| node.label == label)
                    .unwrap_or_else(|| panic!("missing {label}: {}", view.snapshot()))
            };
            let (owner, hit, destination) = (
                target("Touch owner A"),
                target("Touch hit X"),
                target("Touch destination B"),
            );
            let metrics = view.surface().metrics();
            let column = ((hit.frame.origin.x.0 + hit.frame.size.width.0 / 2.0) / metrics.width().0)
                .floor() as u16;
            let row = ((hit.frame.origin.y.0 + hit.frame.size.height.0 / 2.0) / metrics.height().0)
                .floor() as u16;
            let mouse = |kind| {
                Event::Mouse(MouseEvent {
                    kind,
                    column,
                    row,
                    modifiers: event::KeyModifiers::NONE,
                })
            };
            view.handle_event(mouse(MouseEventKind::Down(MouseButton::Left)));
            wait(&mut view, "Touch phases:1/0/0/0");

            let mut items = vec![MountItem::Insert {
                parent: destination.id,
                child: hit.id,
                before: None,
            }];
            if retire {
                items.push(MountItem::RetireListCell {
                    id: owner.id,
                    request: 1,
                    roots: vec![owner.id],
                });
            } else {
                items.push(MountItem::Events {
                    id: owner.id,
                    events: EventMask::default(),
                });
            }
            view.surface_mut().apply(MountBatch { items });
            if retire {
                wait(&mut view, "Touch phases:1/0/0/1");
                view.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left)));
            }
            view.handle_event(mouse(MouseEventKind::Up(MouseButton::Left)));
            let expected = if retire {
                "Touch phases:1/0/0/1"
            } else {
                "Touch phases:1/0/1/0"
            };
            wait(&mut view, expected);
            view.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left)));
            view.handle_event(mouse(MouseEventKind::Up(MouseButton::Left)));
            flush(&mut view);
            assert!(view.snapshot().contains(expected), "{}", view.snapshot());
        }
    }

    #[test]
    fn headless_runner_mounts_edits_activates_and_resizes_a_real_app() {
        run_app(AppSource::Rust(Root::of::<ScriptApp>()), AppOptions {
            size: (80, 24),
            script: Some("expect Ready; expect-focus; type 你好; expect Echo:你好; key Tab; key Enter; expect Count:1; resize 60 18; expect Count:1; quit".into()),
            ..Default::default()
        }).unwrap();
    }

    #[test]
    fn view_keeps_terminal_size_in_virtual_points() {
        let mut view = AppView::new(AppOptions {
            size: (80, 24),
            ..Default::default()
        });
        assert_eq!(
            view.surface().viewport(),
            nsh_core::Size::new(px(640.0), px(384.0))
        );
        view.resize(40, 10);
        assert_eq!(
            view.surface().viewport(),
            nsh_core::Size::new(px(320.0), px(160.0))
        );
        assert!(view.control().is_none());
        assert_eq!(view.environment.renderer, PlatformRenderer::Terminal);
        assert!(view.image_protocol_cleanup().is_empty());
    }

    #[cfg(feature = "js")]
    #[test]
    fn recycled_list_rows_keep_keyboard_order_and_retire_replaced_focus() {
        use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
        use nsh_core::{EventKind, EventPayload};

        const APP: &str = r#"
            import { mount, signal, View, Text, List } from 'nsh';
            import { LayoutAnimation } from 'nsh';
            const rows = signal(Array.from({length: 40}, (_, i) => `row ${i}`));
            const phase = signal('initial');
            const presses = signal(0);
            let list;
            function action(label, run) {
                const name = () => typeof label === 'function' ? label() : label;
                return View({get accessibilityLabel() { return name(); }, onPress: run,
                    style: {height: 32}, children: Text({children: name})});
            }
            mount(() => View({style: {flex: 1}, children: [
                action('Scroll to twelve', () => {
                    list.scrollToIndex({index: 12, animated: false}); phase.set('at twelve');
                }),
                action('Scroll to thirteen', () => {
                    list.scrollToIndex({index: 13, animated: false}); phase.set('at thirteen');
                }),
                action('Scroll to thirty', () => {
                    list.scrollToIndex({index: 30, animated: false}); phase.set('at thirty');
                }),
                action('Filter rows', () => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.linear);
                    rows.set(['match alpha', 'match beta']); phase.set('filtered');
                }),
                action('Replace rows', () => {
                    rows.set(Array.from({length: 40}, (_, i) => `replacement row ${i}`));
                    phase.set('replaced');
                }),
                action('Restore rows', () => {
                    rows.set(Array.from({length: 40}, (_, i) => `row ${i}`));
                    phase.set('restored');
                }),
                List({get each() { return rows(); }, keyExtractor: row => row,
                    ref: node => { list = node; }, estimatedItemSize: 32,
                    style: {height: 128}, focusable: false,
                    header: action('Header action', () => {}),
                    footer: action('Footer action', () => {}),
                    children: row => action(row, () => {
                        presses.set(presses() + 1); phase.set(`Activated ${row()}`);
                    })}),
                Text({children: () => phase()}),
                Text({children: () => `List presses:${presses()}`})
            ]}));
        "#;

        fn wait(view: &mut AppView, started: Instant, ready: impl Fn(&AppView) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                view.tick(started.elapsed().as_secs_f64()).unwrap();
                if ready(view) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "list did not settle: {:?}\n{}",
                    view.last_error(),
                    view.snapshot()
                );
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        fn target(view: &AppView, label: &str) -> Option<nsh_core::NodeId> {
            view.accessibility_snapshot()
                .into_iter()
                .find(|node| node.label == label)
                .map(|node| node.id)
        }
        fn press(view: &AppView, label: &str) {
            view.control().unwrap().dispatch_event(
                target(view, label).unwrap(),
                EventKind::Press,
                EventPayload::None,
            );
        }
        fn focused(view: &AppView) -> Option<String> {
            view.accessibility_snapshot()
                .into_iter()
                .find(|node| node.focused)
                .map(|node| node.label)
        }
        fn tab(view: &mut AppView, backwards: bool) {
            view.handle_event(Event::Key(KeyEvent::new(
                if backwards {
                    KeyCode::BackTab
                } else {
                    KeyCode::Tab
                },
                KeyModifiers::NONE,
            )));
        }

        let started = Instant::now();
        let mut view = AppView::new(AppOptions::default());
        view.load(App::Js(Bundle::source(APP.into()))).unwrap();
        wait(&mut view, started, |view| target(view, "row 0").is_some());
        press(&view, "Scroll to twelve");
        wait(&mut view, started, |view| {
            view.snapshot().contains("at twelve") && target(view, "row 20").is_some()
        });
        let retained = target(&view, "row 12").unwrap();
        view.surface_mut().set_focus(Some(retained));
        tab(&mut view, false);
        assert_eq!(focused(&view).as_deref(), Some("row 13"));
        tab(&mut view, true);
        assert_eq!(focused(&view).as_deref(), Some("row 12"));

        press(&view, "Scroll to thirteen");
        wait(&mut view, started, |view| {
            view.snapshot().contains("at thirteen") && target(view, "row 21").is_some()
        });
        assert_eq!(target(&view, "row 12"), Some(retained));
        assert_eq!(focused(&view).as_deref(), Some("row 12"));

        // Let the engine commit a distant window while the native surface
        // still presents its preceding batch. A user can Tab and activate
        // that displayed row before the queued mount reaches the surface.
        let old_row = target(&view, "row 20").unwrap();
        let before_old_row = target(&view, "row 19").unwrap();
        press(&view, "Scroll to thirty");
        let (committed, ready) = mpsc::channel();
        view.control()
            .unwrap()
            .advance_clock(Duration::ZERO, move || {
                let _ = committed.send(());
            });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(target(&view, "row 20"), Some(old_row));
        view.surface_mut().set_focus(Some(before_old_row));
        tab(&mut view, false);
        assert_eq!(focused(&view).as_deref(), Some("row 20"));
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        wait(&mut view, started, |view| {
            view.snapshot().contains("Activated row 20") && target(view, "List presses:1").is_some()
        });
        assert_eq!(target(&view, "row 20"), Some(old_row));
        assert_eq!(focused(&view).as_deref(), Some("row 20"));

        // Once native focus leaves, the old row can retire and its cell
        // can serve the distant window without delivering another press.
        let outside = target(&view, "Scroll to thirty").unwrap();
        view.surface_mut().set_focus(Some(outside));
        view.dispatch_events();
        press(&view, "Scroll to thirty");
        wait(&mut view, started, |view| {
            view.snapshot().contains("at thirty")
                && target(view, "row 30").is_some()
                && target(view, "row 20").is_none()
        });
        assert!(target(&view, "List presses:1").is_some());
        assert_eq!(focused(&view).as_deref(), Some("Scroll to thirty"));
        press(&view, "Scroll to thirteen");
        wait(&mut view, started, |view| {
            view.snapshot().contains("at thirteen") && target(view, "row 21").is_some()
        });

        // A source deletion ends the old item's lifetime even before the
        // queued native batch is applied. Input from that last displayed
        // frame must never activate its cell's replacement item.
        let deleted_row = target(&view, "row 20").unwrap();
        view.surface_mut().set_focus(Some(deleted_row));
        view.dispatch_events();
        press(&view, "Replace rows");
        let (committed, ready) = mpsc::channel();
        view.control()
            .unwrap()
            .advance_clock(Duration::ZERO, move || {
                let _ = committed.send(());
            });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(target(&view, "row 20"), Some(deleted_row));
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        let (processed, ready) = mpsc::channel();
        view.control()
            .unwrap()
            .advance_clock(Duration::ZERO, move || {
                let _ = processed.send(());
            });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        wait(&mut view, started, |view| {
            target(view, "replacement row 21").is_some()
        });
        assert!(
            target(&view, "List presses:1").is_some(),
            "a deleted row activated its replacement:\n{}",
            view.snapshot()
        );
        press(&view, "Restore rows");
        wait(&mut view, started, |view| {
            view.snapshot().contains("restored") && target(view, "row 21").is_some()
        });

        let replaced = target(&view, "row 20").unwrap();
        view.surface_mut().set_focus(Some(replaced));
        press(&view, "Filter rows");
        wait(&mut view, started, |view| {
            view.snapshot().contains("filtered") && target(view, "match beta").is_some()
        });
        assert_ne!(focused(&view).as_deref(), Some("match alpha"));
        assert_ne!(focused(&view).as_deref(), Some("match beta"));
        let header = target(&view, "Header action").unwrap();
        view.surface_mut().set_focus(Some(header));
        for label in ["match alpha", "match beta", "Footer action"] {
            tab(&mut view, false);
            assert_eq!(focused(&view).as_deref(), Some(label));
        }
        view.stop();
    }

    #[cfg(feature = "js")]
    #[test]
    fn nested_list_focus_reveals_the_canonical_row_after_a_membership_gap() {
        use nsh_core::{EventKind, EventPayload};

        const APP: &str = r#"
            import { mount, signal } from 'nsh';
            import { element, prop, insert, append, list } from 'nsh:rt';
            const stage = signal('preview'), opened = signal(false), height = signal(416);
            const phase = signal('initial');
            let outer, inner, requestFocus = false;
            function label(text) {
                const node = element('text');
                insert(node, text);
                return node;
            }
            function action(name, run) {
                const node = element('view');
                prop(node, 'accessibilityLabel', name);
                prop(node, 'onPress', run);
                append(node, label(name));
                return node;
            }
            mount(() => {
                const root = element('view');
                prop(root, 'style', {flex: 1});
                append(root, action('Navigate', () => {
                    opened.set(true);
                    outer.scrollToIndex({index: 51, viewPosition: 0});
                    requestFocus = true;
                    if (inner) {
                        requestFocus = false;
                        inner.focus();
                    } else outer.focus();
                    phase.set('navigated');
                }));
                append(root, action('Settle', () => {
                    if (GAPPED) stage.set('gap');
                    phase.set('settled');
                }));
                append(root, action('Publish', () => {
                    height.set(400);
                    stage.set('canonical');
                    phase.set('published');
                }));
                append(root, label(() => phase()));
                append(root, list({
                    get each() {
                        return Array.from({length: stage() === 'gap' ? 51 : 52}, (_, i) => i);
                    },
                    estimatedItemSize: 96,
                    maintainVisibleContentPosition: {autoscrollToBottomThreshold: 32},
                    get style() { return {height: height()}; },
                    accessibilityLabel: 'Outer history',
                    ref: node => { outer = node; node.scrollToEnd({animated: false}); },
                    children: id => {
                        const row = element('view');
                        insert(row, () => {
                            if (id() !== 51) {
                                const history = element('view');
                                prop(history, 'style', {height: 320 + (id() % 3) * 16});
                                append(history, label('HISTORY_' + id()));
                                return history;
                            }
                            const group = element('view');
                            prop(group, 'style', {paddingVertical: 16});
                            append(group, label(() => stage() === 'canonical'
                                ? 'WORKING_TARGET' : 'PREPARING_TARGET'));
                            insert(group, () => opened() && stage() === 'canonical' ? list({
                                each: ['canonical'],
                                estimatedItemSize: 16,
                                contentOffset: {y: 0},
                                style: {height: 16},
                                accessibilityLabel: 'Target activity',
                                ref: node => {
                                    inner = node;
                                    node.scrollToEnd({animated: false});
                                    if (requestFocus) { requestFocus = false; node.focus(); }
                                },
                                children: key => label(() => key() + ' literal body')
                            }) : null);
                            return group;
                        });
                        return row;
                    }
                }));
                return root;
            });
        "#;

        fn wait(view: &mut AppView, started: Instant, ready: impl Fn(&AppView) -> bool) -> bool {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                view.tick(started.elapsed().as_secs_f64()).unwrap();
                if ready(view) {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }

        fn press(view: &AppView, label: &str) {
            let target = view
                .accessibility_snapshot()
                .into_iter()
                .find(|node| node.label == label)
                .expect("handoff action must be mounted");
            view.control()
                .unwrap()
                .dispatch_event(target.id, EventKind::Press, EventPayload::None);
        }

        let mut outcomes = Vec::new();
        for gap in [false, true] {
            let started = Instant::now();
            let mut view = AppView::new(AppOptions::default());
            view.load(App::Js(Bundle::source(
                APP.replace("GAPPED", if gap { "true" } else { "false" }),
            )))
            .unwrap();
            assert!(
                wait(&mut view, started, |view| {
                    view.snapshot().contains("PREPARING_TARGET") && !view.surface().animating()
                }),
                "initial target did not mount: gap={gap}, error={:?}",
                view.last_error()
            );
            // Acknowledgments ensure the temporary removal reaches a real
            // presentation before publication; no second reveal is issued.
            for (action, phase) in [("Navigate", "navigated"), ("Settle", "settled")] {
                press(&view, action);
                assert!(
                    wait(&mut view, started, |view| view.snapshot().contains(phase)),
                    "handoff action did not commit: gap={gap}, action={action}, error={:?}",
                    view.last_error()
                );
            }
            press(&view, "Publish");
            let visible_and_focused = wait(&mut view, started, |view| {
                let snapshot = view.snapshot();
                snapshot.contains("WORKING_TARGET")
                    && snapshot.contains("canonical literal body")
                    && view
                        .accessibility_snapshot()
                        .iter()
                        .any(|node| node.label == "Target activity" && node.focused)
                    && !view.surface().animating()
            });
            view.stop();
            outcomes.push((gap, visible_and_focused));
        }
        assert_eq!(outcomes, [(false, true), (true, true)]);
    }

    #[cfg(feature = "js")]
    #[test]
    fn scoped_shortcuts_and_resize_read_the_same_native_focus_without_observing_it() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

        let mut view = AppView::new(AppOptions::default());
        view.load(App::Js(Bundle::source(r#"
            import { mount, signal, effect, View, Text } from 'nsh';
import { Input } from 'nsh/base';
            import { windowSize } from 'nsh';
            import { keymap } from 'nsh';
            const result = signal('starting');
            let reads = 0;
            const search = Input({autoFocus: true, style: {height: 32}});
            const browser = View({children: search});
            const composer = Input({style: {height: 32}});
            keymap.bind('ctrl+k', () => result.set(`read ${keymap.focusedWithin(browser)} #${reads}`), {when: 'always'});
            keymap.bind('ctrl+k', () => result.set(`scoped #${reads}`), {when: 'always', within: search});
            effect(() => {
                const width = windowSize().width;
                result.set(`resize ${width} browser=${keymap.focusedWithin(browser)} #${++reads}`);
            });
            mount(() => View({children: [browser, composer, Text({children: () => result()})]}));
        "#.into()))).unwrap();
        let wait = |view: &mut AppView, expected: &str| {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                view.poll().unwrap();
                if view.snapshot().contains(expected) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "{} / {:?}",
                    view.snapshot(),
                    view.last_error()
                );
                std::thread::sleep(Duration::from_millis(2));
            }
        };
        wait(&mut view, "resize 960 browser=false #1");
        let key = |view: &mut AppView, code, modifiers| {
            view.handle_event(crossterm::event::Event::Key(KeyEvent::new(code, modifiers)));
        };
        key(&mut view, KeyCode::Char('k'), KeyModifiers::CONTROL);
        wait(&mut view, "scoped #1");
        key(&mut view, KeyCode::Tab, KeyModifiers::NONE);
        key(&mut view, KeyCode::Char('k'), KeyModifiers::CONTROL);
        wait(&mut view, "read false #1");
        view.resize(60, 30);
        wait(&mut view, "resize 480 browser=false #2");
        key(&mut view, KeyCode::BackTab, KeyModifiers::SHIFT);
        view.resize(70, 30);
        wait(&mut view, "resize 560 browser=true #3");
    }

    #[test]
    fn graphics_cleanup_ids_survive_replacing_the_app() {
        let mut view = AppView::new(AppOptions::default());
        view.set_image_protocol(Some(
            crate::ImageProtocol::new(crate::ProtocolType::Kitty, 8, 16).unwrap(),
        ));
        let cleanup = view.image_protocol_cleanup();
        assert!(!cleanup.is_empty());
        for _ in 0..2 {
            view.load(App::Rust(Root::of::<ScriptApp>())).unwrap();
            assert_eq!(view.image_protocol_cleanup(), cleanup);
        }
    }

    #[component]
    fn StorageApp() -> impl IntoElement {
        use nsh_core::storage::Storage;

        let launches = Storage::get_item("launches")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0)
            + 1;
        Storage::set_item("launches", launches.to_string()).unwrap();
        text(format!("Launches:{launches}"))
    }

    fn storage_directory(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "nsh-tui-storage-{name}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wait_for_storage(view: &mut AppView, file: &std::path::Path, launches: u32) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let expected = launches.to_string();
        loop {
            view.poll().unwrap();
            assert_eq!(view.last_error(), None);
            let stored = std::fs::read(file)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            if stored.as_ref().and_then(|value| value["launches"].as_str())
                == Some(expected.as_str())
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "storage was {stored:?} at {file:?}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn storage_survives_view_reloads_and_keeps_app_ids_separate() {
        let dir = storage_directory("app-ids");
        let options = AppOptions {
            data_dir: Some(dir.clone()),
            ..Default::default()
        };
        let mut view = AppView::new(options.clone());
        for (id, launches) in [
            ("com.acme.orders", 1),
            ("com.acme.notes", 1),
            ("com.acme.orders", 2),
        ] {
            view.load(Root::of::<StorageApp>().app_id(id).into())
                .unwrap();
            wait_for_storage(&mut view, &dir.join(id).join("storage.json"), launches);
        }
        view.stop();
        let mut next = AppView::new(options);
        next.load(Root::of::<StorageApp>().app_id("com.acme.orders").into())
            .unwrap();
        wait_for_storage(&mut next, &dir.join("com.acme.orders/storage.json"), 3);
        next.stop();
        assert!(!dir.join("default").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn embedding_storage_overrides_the_system_and_app_directories() {
        let dir = storage_directory("embedding");
        let mut view = AppView::new(AppOptions {
            data_dir: Some(dir.join("apps")),
            storage: Some(nsh_engine::FileStorage::open(dir.join("host-storage"))),
            ..Default::default()
        });
        view.load(Root::of::<StorageApp>().app_id("com.acme.orders").into())
            .unwrap();
        wait_for_storage(&mut view, &dir.join("host-storage/storage.json"), 1);
        view.stop();
        assert!(!dir.join("apps").exists());
        drop(view);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(feature = "dev")]
    #[test]
    fn test_agent_messages_leave_the_terminal_app_unchanged() {
        use nsh_dev::{DevEvent, protocol::FetchReply};

        let mut view = AppView::new(AppOptions::default());
        view.load(Root::of::<ScriptApp>().into()).unwrap();
        let engine = view.engine.as_ref().unwrap() as *const Engine;
        view.status = Some("Building".into());
        view.last_error = Some("previous diagnostic".into());

        for event in [
            DevEvent::Testing,
            DevEvent::Root,
            DevEvent::TestSetup {
                storage: vec![("launches".into(), "99".into())],
                trace: true,
                environment: Default::default(),
            },
            DevEvent::Fetch {
                id: 1,
                reply: FetchReply::Pass,
            },
            DevEvent::Fetch {
                id: 1,
                reply: FetchReply::Failed {
                    message: "test request failed".into(),
                },
            },
        ] {
            view.dev_event(event).unwrap();
            assert_eq!(view.engine.as_ref().unwrap() as *const Engine, engine);
            assert_eq!(view.status.as_deref(), Some("Building"));
            assert_eq!(view.last_error(), Some("previous diagnostic"));
            assert!(view.options.storage.is_none());
        }
    }

    #[cfg(feature = "dev")]
    #[test]
    fn development_bundles_enforce_the_hosts_requested_limits() {
        use nsh_dev::{DevEvent, protocol::BundleFormat};

        let mut view = AppView::new(AppOptions::default());
        view.connect("ws://127.0.0.1:0/ws".into()).unwrap();
        view.dev_event(DevEvent::Bundle {
            session: 1,
            version: 1,
            format: BundleFormat::Source,
            bytes: br#"import { mount, View, Text } from 'nsh';
                mount(() => View({ children: Text({ children: 'over quota' }) }));"#
                .to_vec(),
            source_map: None,
            capabilities: None,
            app_id: None,
            limits: Some("nodes=1".into()),
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while view.last_error().is_none() {
            view.poll().unwrap();
            assert!(
                Instant::now() < deadline,
                "host node limit was not enforced"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            view.last_error(),
            Some("the app created more than 1 nodes and was stopped")
        );
    }

    #[cfg(feature = "dev")]
    #[test]
    fn development_bundles_keep_their_storage_identity_after_hot_updates_and_reload() {
        use nsh_dev::{DevEvent, protocol::BundleFormat};

        let dir = storage_directory("development");
        let mut view = AppView::new(AppOptions {
            data_dir: Some(dir.clone()),
            ..Default::default()
        });
        view.connect("ws://127.0.0.1:0/ws".into()).unwrap();
        let bundle = |version, app_id: &str| DevEvent::Bundle {
            session: 1,
            version,
            format: BundleFormat::Source,
            bytes: br#"import { Storage } from "nsh";
                Storage.getItem("launches").then(value =>
                    Storage.setItem("launches", String(Number(value ?? "0") + 1)));"#
                .to_vec(),
            source_map: None,
            capabilities: None,
            app_id: Some(app_id.into()),
            limits: None,
        };
        view.dev_event(bundle(1, "com.acme.orders")).unwrap();
        wait_for_storage(&mut view, &dir.join("com.acme.orders/storage.json"), 1);
        view.dev_event(DevEvent::Patch {
            session: 1,
            version: 2,
            base: 1,
            code: "true".into(),
            source_map: None,
        })
        .unwrap();
        view.dev_event(bundle(2, "com.acme.orders")).unwrap();
        assert_eq!(
            view.dev
                .as_ref()
                .unwrap()
                .latest
                .as_ref()
                .unwrap()
                .2
                .app_id
                .as_deref(),
            Some("com.acme.orders")
        );
        view.reload_latest().unwrap();
        wait_for_storage(&mut view, &dir.join("com.acme.orders/storage.json"), 2);
        view.dev_event(bundle(3, "com.acme.notes")).unwrap();
        wait_for_storage(&mut view, &dir.join("com.acme.notes/storage.json"), 1);
        view.stop();
        assert!(!dir.join("default").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn app_errors_cannot_emit_terminal_control_sequences() {
        assert_eq!(
            safe_diagnostic("error\n\u{1b}]52;clipboard\u{7}\tline"),
            "error\n]52;clipboard\tline"
        );
        // Parsing fails before mounting the source. The public runner
        // must sanitize the error that a host prints after it returns.
        let error = run_app(
            AppSource::Rust(Root::of::<ScriptApp>()),
            AppOptions {
                script: Some("invalid\u{1b}]52\u{7}\u{9b}31m".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(error.to_string(), "invalid script step: invalid]5231m");
    }

    #[cfg(feature = "dev")]
    #[test]
    fn forwarded_logs_cannot_inject_clipboard_or_c1_terminal_commands() {
        let record = LogRecord {
            level: log::Level::Info,
            target: "js\u{1b}]52;target\u{7}\u{9b}31m".into(),
            message: "hello\n\t\u{1b}]52;c;Y2xpcGJvYXJk\u{7}\u{9b}31m\u{9d}52;c;secret\u{9c}"
                .into(),
        }
        .terminal_safe();
        assert_eq!(record.target, "js]52;target31m");
        assert_eq!(record.message, "hello\n\t]52;c;Y2xpcGJvYXJk31m52;c;secret");
        assert!(!record.target.chars().any(char::is_control));
        assert!(
            !record
                .message
                .chars()
                .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\t'))
        );
    }

    #[cfg(feature = "dev")]
    #[test]
    fn asset_urls_follow_dev_server_scheme() {
        assert_eq!(
            dev_asset_base("ws://localhost:8790/ws"),
            Some("http://localhost:8790/assets/".into())
        );
        assert_eq!(
            dev_asset_base("wss://example.org/path/ws"),
            Some("https://example.org/assets/".into())
        );
        assert_eq!(dev_asset_base("http://localhost/ws"), None);
        assert_eq!(dev_asset_base("ws:///ws"), None);
    }
}
