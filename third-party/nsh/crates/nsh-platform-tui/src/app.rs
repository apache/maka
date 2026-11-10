#[cfg(feature = "dev")]
#[path = "agent.rs"]
mod agent;
#[cfg(feature = "dev")]
#[path = "dev.rs"]
mod dev;

use std::{
    io,
    ops::Range,
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use nsh_core::{Bounds, Point, Points, ROOT_ID, Size, ViewKind, text_edit};
use nsh_engine::{App, AppError, Engine, EngineConfig, Environment, HostChannel, Idiom, Limits};
use ratatui_core::{
    buffer::Buffer,
    layout::{Position, Rect},
    terminal::Frame,
    widgets::Widget,
};

use crate::{
    Appearance, CellSize, CellTextEngine, ComponentFactory, Handled, Input,
    input::Pointer,
    mount::Mounter,
    render::{self, Hit},
    surface::{Message, Runtime, Sink, Surface},
};

/// The machine's operating system, reported as the desktop hosts report theirs:
/// files, processes and OS-specific behavior follow it.
pub(crate) const OS: nsh_core::platform::Os = if cfg!(target_os = "macos") {
    nsh_core::platform::Os::MacOs
} else if cfg!(target_os = "windows") {
    nsh_core::platform::Os::Windows
} else {
    nsh_core::platform::Os::Linux
};

/// Called from the engine thread to schedule a render on the embedding thread.
pub type WakeCallback = Arc<dyn Fn() + Send + Sync>;

/// One accessible element in paint/tree order, scoped to the active modal.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessibleNode {
    /// Mounted node identifier.
    pub id: nsh_core::NodeId,
    /// Shared point geometry.
    pub frame: Bounds<Points>,
    /// Semantic role, independent of terminal glyphs.
    pub role: nsh_core::AccessibilityRole,
    /// Accessible label, with secure input content omitted.
    pub label: String,
    /// Optional interaction hint.
    pub hint: Option<String>,
    /// Current interaction state.
    pub state: nsh_core::AccessibilityState,
    /// Range or descriptive value; secure fields omit it.
    pub value: Option<nsh_core::AccessibilityValue>,
    /// Whether the terminal assigned keyboard focus.
    pub focused: bool,
    /// Declared semantic actions.
    pub actions: Vec<nsh_core::AccessibilityActionDef>,
}

/// A focused input's native editing context for a host's completion,
/// autocorrection or autofill service.
#[derive(Clone, Debug, PartialEq)]
pub struct InputContext {
    /// The focused input.
    pub node: nsh_core::NodeId,
    /// Current text, redacted for secure inputs.
    pub text: Option<String>,
    /// Selected UTF-16 range, or the caret when empty.
    pub selection: Range<u32>,
    /// Native edit generation that a replacement must acknowledge.
    pub event_count: u32,
    /// Intended keyboard content.
    pub keyboard: nsh_core::KeyboardType,
    /// Capitalization hint for a host keyboard.
    pub auto_capitalize: nsh_core::AutoCapitalize,
    /// Whether the app requests correction suggestions.
    pub auto_correct: bool,
    /// Autofill content hint.
    pub auto_fill: nsh_core::AutoFill,
    /// The input hides its text; hosts keep automatic suggestions private.
    pub secure: bool,
    /// The mounted input currently accepts edits.
    pub editable: bool,
    /// The input accepts line breaks.
    pub multiline: bool,
    /// Maximum text length in UTF-16 units.
    pub max_length: Option<u32>,
}

/// Terminal information supplied by the host. Further capabilities are added with their renderers.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct TerminalCapabilities {
    /// System appearance; dark when the host has no background information.
    pub background: nsh_core::platform::ColorScheme,
    /// The colors the terminal can show; app colors are drawn at this depth.
    pub colors: ColorDepth,
    /// The terminal's default background (OSC 11). At 256 colors or more
    /// it is the base of the terminal's surfaces: app fills, selections,
    /// hover and press drawn as steps of it mixed toward
    /// [`Self::foreground_color`], secondary text as fades. Without it
    /// the look is bandless: no fills, reverse video and dim text.
    pub background_color: Option<[u8; 3]>,
    /// The terminal's default foreground (OSC 10): what the surfaces' steps
    /// mix toward (white or black against the background when unknown).
    pub foreground_color: Option<[u8; 3]>,
    /// The terminal reports the Command (Super) modifier, through the kitty
    /// keyboard protocol. Without it, Ctrl stands in for Cmd in the app's
    /// shortcuts on macOS.
    pub command_key: bool,
}

/// The colors a terminal shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum ColorDepth {
    /// 24-bit RGB (`COLORTERM=truecolor`).
    #[default]
    TrueColor,
    /// The xterm 256-color palette.
    Ansi256,
    /// The 16 named colors.
    Ansi16,
    /// No colors (`NO_COLOR`): states and marks are drawn with reverse
    /// video, bold, underline and dim alone.
    Monochrome,
}

impl Default for TerminalCapabilities {
    fn default() -> Self {
        Self {
            background: nsh_core::platform::ColorScheme::Dark,
            colors: ColorDepth::default(),
            background_color: None,
            foreground_color: None,
            command_key: false,
        }
    }
}

/// Configuration of one terminal surface. Embedding uses bounded engine limits.
#[non_exhaustive]
pub struct AppOptions {
    /// Grid scale, shared by layout, drawing and input.
    pub cells: CellSize,
    /// Terminal properties determined by the embedding host.
    pub capabilities: TerminalCapabilities,
    /// Optional image rendering protocol (Unicode half-blocks or Sixel).
    pub image_protocol: Option<crate::ImageProtocol>,
    /// App appearance override.
    pub appearance: Appearance,
    /// Notification that the surface has pending work.
    pub wake: Option<WakeCallback>,
    /// VM and core resource limits.
    pub limits: Limits,
    /// Image and response cache policy.
    pub cache: nsh_engine::CacheOptions,
    /// Persistent app data directory.
    pub data_dir: Option<PathBuf>,
    /// Registries available to app code.
    pub ui_sets: Vec<nsh_core::element::Registry>,
    /// Embedding app's channel, retained across loads.
    pub host: HostChannel,
    /// Optional app storage implementation.
    pub storage: Option<Arc<dyn nsh_core::storage::StorageBackend>>,
    /// Optional asset reader supplied by the embedding app.
    pub assets: Option<Arc<dyn nsh_engine::Assets>>,
    /// Clipboard implementation supplied by the host.
    pub clipboard: Option<Arc<dyn nsh_core::clipboard::ClipboardBackend>>,
    /// Log engine timings through `nsh::perf`.
    pub trace: bool,
    /// Show the terminal frame monitor.
    pub fps: bool,
    /// Root linked into an app-specific development host.
    #[cfg(feature = "dev")]
    pub root: Option<nsh_engine::Root>,
}

impl Default for AppOptions {
    fn default() -> Self {
        Self {
            cells: CellSize::default(),
            capabilities: TerminalCapabilities::default(),
            image_protocol: None,
            appearance: Appearance::System,
            wake: None,
            limits: Limits::default(),
            cache: nsh_engine::CacheOptions::default(),
            data_dir: None,
            ui_sets: vec![nsh_base::registry()],
            host: HostChannel::default(),
            storage: None,
            assets: None,
            clipboard: None,
            trace: false,
            fps: false,
            #[cfg(feature = "dev")]
            root: None,
        }
    }
}

type ErrorCallback = Box<dyn FnMut(&AppError)>;
type TextErrorCallback = Box<dyn FnMut(&str)>;

/// How long a key waits for the engine to run a focus change before it is matched.
const FOCUS_CATCH_UP: Duration = Duration::from_millis(100);

/// One passive NSH surface. Rendering applies pending engine commits and invokes callbacks; a key
/// right after a focus change also applies the commits that change made.
#[non_exhaustive]
pub struct AppView {
    options: AppOptions,
    perf: Option<crate::perf::Monitor>,
    output: crate::perf::SharedOutput,
    #[cfg(feature = "dev")]
    dev: Option<dev::DevSession>,
    /// The development server's `asset:/` files, unless the embedder supplies a reader.
    #[cfg(feature = "dev")]
    dev_assets: Option<Arc<dyn nsh_engine::Assets>>,
    #[cfg(feature = "dev")]
    diagnostics: dev::Diagnostics,
    #[cfg(feature = "dev")]
    test: Option<agent::TestSession>,
    surface: Surface,
    tree: Mounter,
    images: crate::image::ImageStore,
    scratch: Buffer,
    area: Rect,
    focused: bool,
    input_paused: bool,
    clipboard: Arc<dyn nsh_core::clipboard::ClipboardBackend>,
    kill: String,
    field_drag: Option<FieldDrag>,
    /// The press on a text field that listens to presses (a combobox's
    /// field): the field takes the pointer, and the press still ends as
    /// one does, `onPress` when the pointer comes up on the field. With
    /// the field's view origin and its Cells.
    field_press: Option<(
        nsh_core::input::Press<nsh_core::NodeId>,
        Point<Points>,
        Rect,
    )>,
    /// The stop a primary press went down on (or inside), which takes the
    /// focus as the press comes up: while it is held the view shows the
    /// press, not the focus.
    press_focus: Option<nsh_core::NodeId>,
    /// The next `draw_terminal` repaints every Cell (the terminal came back to focus).
    repaint: bool,
    pointer: Pointer,
    bar_drag: Option<crate::input::BarDrag>,
    /// Scroll views moved since they last came to rest: settled (the
    /// animator's `scroll_ended`) once no drag holds them.
    unsettled: Vec<nsh_core::NodeId>,
    cursor_style: crate::CursorStyle,
    on_cursor_style: Option<Box<dyn FnMut(crate::CursorStyle)>>,
    selection: crate::selection::Selection,
    hits: Vec<Hit>,
    geometry: Vec<crate::render::Geometry>,
    keyboard: crate::keyboard::Keyboard,
    minibuffer: crate::search::Minibuffer,
    environment: Environment,
    appearance_changed: bool,
    last_error: Option<String>,
    on_error: Option<TextErrorCallback>,
    on_app_error: Option<ErrorCallback>,
    on_appearance: Option<Box<dyn FnMut(Appearance)>>,
}

impl Default for AppView {
    fn default() -> Self {
        Self::new(AppOptions::default())
    }
}

impl AppView {
    /// Creates an empty surface; it takes over no terminal state or event loop.
    pub fn new(options: AppOptions) -> Self {
        let environment = Environment {
            os: OS,
            idiom: Idiom::Terminal,
            color_scheme: options.appearance.resolve(options.capabilities.background),
            reduce_motion: false,
            native_focus_scopes: true,
            fallback_key_bindings: true,
            // The core lays out on the terminal's Cells: every frame here is
            // whole Cells and every border owns its own.
            cell: Some(nsh_core::Size::new(
                options.cells.width(),
                options.cells.height(),
            )),
            // Without the kitty keyboard protocol a macOS terminal cannot
            // report Command: Ctrl stands in for it, and labels say so.
            ctrl_for_command: OS == nsh_core::platform::Os::MacOs
                && !options.capabilities.command_key,
            ..Default::default()
        };
        let clipboard = options
            .clipboard
            .clone()
            .unwrap_or_else(|| Arc::new(nsh_core::clipboard::MemoryClipboard::default()));
        let surface = Surface::default();
        surface.wake.set(options.wake.clone());
        let fps = options.fps || nsh_engine::perf::enabled_by_env();
        let output = crate::perf::SharedOutput::default();
        output.enabled.set(fps);
        let mut images = crate::image::ImageStore::default();
        let _ = images.set_protocol(options.image_protocol);
        Self {
            perf: fps.then(crate::perf::Monitor::new),
            output,
            options,
            #[cfg(feature = "dev")]
            dev: None,
            #[cfg(feature = "dev")]
            dev_assets: None,
            #[cfg(feature = "dev")]
            diagnostics: dev::Diagnostics::default(),
            #[cfg(feature = "dev")]
            test: None,
            surface,
            tree: {
                let mut tree = Mounter::default();
                tree.menus.ctrl_for_command = environment.ctrl_for_command;
                tree
            },
            images,
            scratch: Buffer::default(),
            area: Rect::default(),
            focused: true,
            input_paused: false,
            clipboard,
            kill: String::new(),
            field_drag: None,
            field_press: None,
            press_focus: None,
            repaint: false,
            pointer: Pointer::default(),
            bar_drag: None,
            unsettled: Vec::new(),
            cursor_style: crate::CursorStyle::Default,
            on_cursor_style: None,
            selection: Default::default(),
            hits: Vec::new(),
            geometry: Vec::new(),
            keyboard: Default::default(),
            minibuffer: Default::default(),
            environment,
            appearance_changed: false,
            last_error: None,
            on_error: None,
            on_app_error: None,
            on_appearance: None,
        }
    }

    /// Replaces the app and starts its engine. Startup errors of app code arrive during render.
    pub fn load(&mut self, app: impl Into<App>) -> io::Result<()> {
        self.stop();
        self.load_app(app.into())
    }

    fn load_app(&mut self, app: App) -> io::Result<()> {
        let mut config = EngineConfig::new(app);
        config.viewport = self.size();
        config.environment = self.environment;
        config.ui_sets = self.options.ui_sets.clone();
        config.limits = self.options.limits;
        config.cache = self.options.cache.clone();
        config.host = self.options.host.clone();
        config.trace = self.options.trace;
        self.load_with_config(config)
    }

    fn prepare_config(&mut self, config: &mut EngineConfig) {
        let cells = self.options.cells;
        if self.area.is_empty()
            && config.viewport.width > Points(0.0)
            && config.viewport.height > Points(0.0)
        {
            let columns = (config.viewport.width / cells.width()).round().max(1.0) as u16;
            let rows = (config.viewport.height / cells.height()).round().max(1.0) as u16;
            self.area = Rect::new(0, 0, columns, rows);
        }
        let viewport = self.size();
        config.viewport = viewport;
        config.header_heights = nsh_core::NO_NATIVE_HEADER;
        if config.environment == Environment::default() {
            config.environment = self.environment;
        } else {
            if config.environment.os == nsh_core::platform::Os::default() {
                config.environment.os = OS;
                if OS == nsh_core::platform::Os::MacOs && !self.options.capabilities.command_key {
                    config.environment.ctrl_for_command = true;
                }
            }
            if config.environment.idiom == Idiom::default() {
                config.environment.idiom = Idiom::Terminal;
            }
        }
        config.environment.window = viewport;
        config.environment.native_focus_scopes = true;
        config.environment.fallback_key_bindings = true;
        config
            .environment
            .cell
            .get_or_insert(Size::new(cells.width(), cells.height()));
        self.environment = config.environment;
        self.tree.menus.ctrl_for_command = self.environment.ctrl_for_command;
        if config.ui_sets.is_empty() {
            config.ui_sets = self.options.ui_sets.clone();
        }
        config.network.get_or_insert_with(nsh_engine::net::network);
        if config.data_dir.is_none() {
            config.data_dir = self.options.data_dir.clone();
        }
        if config.assets.is_some() {
            self.options.assets = config.assets.clone();
        } else {
            config.assets = self.options.assets.clone();
            #[cfg(feature = "dev")]
            if config.assets.is_none() {
                config.assets = self.dev_assets.clone();
            }
        }
        if config.storage.is_none() {
            config.storage = self.options.storage.clone();
        }
        if let Some(clipboard) = &config.clipboard {
            self.clipboard = clipboard.clone();
        } else {
            config.clipboard = Some(self.clipboard.clone());
        }
        self.options.host = config.host.clone();
    }

    /// Starts a threaded [`Engine`] from an embedder-configured [`EngineConfig`].
    pub fn load_with_config(&mut self, mut config: EngineConfig) -> io::Result<()> {
        self.stop_engine();
        self.prepare_config(&mut config);
        #[cfg(feature = "dev")]
        if let Some(test) = &self.test {
            test.model.set_up_engine(&mut config);
        }
        self.clipboard = config
            .clipboard
            .clone()
            .unwrap_or_else(|| Arc::new(nsh_core::clipboard::MemoryClipboard::default()));
        let access = Arc::new(match &config.app {
            App::Js(bundle) => bundle.policy.access(),
            App::Rust(_) => nsh_engine::Policy::default().access(),
        });
        let assets = config.assets.clone();
        let viewport = config.viewport;
        let cells = self.options.cells;
        let (sender, inbox) = crossbeam_channel::unbounded();
        let sink = Sink {
            sender: sender.clone(),
            wake: self.surface.wake.clone(),
        };
        self.surface.sink = sink.clone();
        self.keyboard.sync = Some((sender, self.surface.wake.clone()));
        let engine = Engine::start(config, move || CellTextEngine::new(cells), sink)?;
        self.images
            .set_resources(assets, access, engine.image_cache());
        #[cfg(feature = "dev")]
        if let Some(test) = &self.test {
            test.model.engine_started(engine.control());
        }
        if let Some(perf) = &self.perf {
            engine.control().set_perf_monitor(Some(perf.engine.clone()));
        }
        self.surface.runtime = Some(Runtime::Threaded(engine));
        self.surface.inbox = inbox;
        self.surface.laid_out = viewport;
        Ok(())
    }

    /// Starts a single-threaded [`nsh_engine::LocalEngine`] owned by this surface.
    pub fn load_local(&mut self, mut config: EngineConfig) -> Result<(), String> {
        self.stop_engine();
        self.prepare_config(&mut config);
        let cells = self.options.cells;
        let viewport = config.viewport;
        let access = Arc::new(match &config.app {
            App::Js(bundle) => bundle.policy.access(),
            App::Rust(_) => nsh_engine::Policy::default().access(),
        });
        let assets = config.assets.clone();
        let (sender, inbox) = crossbeam_channel::unbounded();
        let sink = Sink {
            sender: sender.clone(),
            wake: self.surface.wake.clone(),
        };
        self.surface.sink = sink.clone();
        self.surface.inbox = inbox;
        self.keyboard.sync = Some((sender, self.surface.wake.clone()));
        let mut local = nsh_engine::LocalEngine::start(config, CellTextEngine::new(cells), sink)
            .ok_or_else(|| "NSH UI engine failed to start".to_owned())?;
        let wake = Arc::clone(&self.surface.wake);
        local.set_wake(Arc::new(move || wake.notify()));
        if let Some(perf) = &self.perf {
            local.control().set_perf_monitor(Some(perf.engine.clone()));
        }
        let disk = local.image_cache();
        self.images.set_resources(assets, access, disk);
        self.surface.local_deadline = local.pump();
        self.surface.laid_out = viewport;
        self.surface.runtime = Some(Runtime::Local(Box::new(local)));
        Ok(())
    }

    /// Pumps a local engine, applies pending commits, and updates layout and hit geometry
    /// without advancing `requestAnimationFrame` callbacks.
    pub fn pump(&mut self) -> Result<bool, String> {
        let mut changed = false;
        let mut first = true;
        while first || (self.surface.is_local() && !self.keyboard.is_caught_up()) {
            first = false;
            if let Some(Runtime::Local(local)) = &mut self.surface.runtime {
                self.surface.local_deadline = local.pump();
            }
            let had_messages = !self.surface.held.is_empty() || !self.surface.inbox.is_empty();
            let area = self.area;
            let mut next = Buffer::empty(area);
            let first_err = self.draw_scene(area, &mut next, false);
            if next != self.scratch || had_messages {
                changed = true;
            }
            self.scratch = next;
            if let Some(text) = first_err {
                return Err(text);
            }
            if !self.surface.is_local() {
                break;
            }
        }
        Ok(changed)
    }

    /// Advances one `requestAnimationFrame` turn when a frame callback is pending.
    pub fn begin_frame(&mut self) {
        self.surface.begin_frame();
    }

    /// Updates the grid dimensions for headless or explicitly sized hosts.
    pub fn resize(&mut self, columns: u16, rows: u16) {
        let next = Rect::new(0, 0, columns, rows);
        if self.area == next {
            return;
        }
        let control = self.surface.control();
        self.pointer.cancel(&mut self.tree, control.as_ref());
        self.area = next;
        let viewport = self.size();
        self.environment.window = viewport;
        if let Some(control) = control {
            control.resize(viewport);
            control.set_environment(self.environment);
        }
        if self.surface.is_local() {
            self.surface.laid_out = viewport;
        }
        self.surface.wake.notify();
    }

    /// Configures the terminal image rendering protocol (`None` disables image rendering).
    pub fn set_image_protocol(&mut self, protocol: Option<crate::ImageProtocol>) {
        if !self.images.set_protocol(protocol) {
            return;
        }
        if protocol.is_some() {
            let control = self.surface.control();
            let cells = self.options.cells;
            let ids: Vec<nsh_core::NodeId> = self
                .tree
                .views
                .iter()
                .enumerate()
                .filter_map(|(idx, slot)| {
                    slot.as_ref()
                        .filter(|v| v.kind == ViewKind::Image)
                        .map(|_| idx as nsh_core::NodeId)
                })
                .collect();
            for id in ids {
                if let Some(view) = self.tree.get(id) {
                    self.images.sync_view(
                        id,
                        view.image.as_ref(),
                        view.frame.size,
                        view.events,
                        cells,
                        &self.surface.sink,
                        control.as_ref(),
                    );
                }
            }
        }
        self.surface.wake.notify();
    }

    /// Pauses or resumes user input routing (preserving focus lifecycle updates).
    pub fn set_input_paused(&mut self, paused: bool) {
        self.input_paused = paused;
        if paused {
            self.cancel_pointer();
        }
    }

    /// Cancels active pointer, field-drag and scrollbar gestures.
    pub fn cancel_pointer(&mut self) {
        let control = self.surface.control();
        if let Some(control) = &control {
            self.pointer.leave(&mut crate::input::PointerContext {
                area: self.area,
                cells: self.options.cells,
                hits: &self.hits,
                geometry: &self.geometry,
                tree: &mut self.tree,
                control,
            });
        }
        self.pointer.cancel(&mut self.tree, control.as_ref());
        self.field_drag = None;
        self.field_press = None;
        self.press_focus = None;
        self.bar_drag = None;
    }

    /// Whether the engine or inbox has pending work ready to pump immediately.
    pub fn needs_pump(&self) -> bool {
        !self.surface.inbox.is_empty()
            || !self.surface.held.is_empty()
            || matches!(&self.surface.runtime, Some(Runtime::Local(local)) if local.needs_pump())
    }

    /// Next timer deadline of a local engine, if any.
    pub fn timer_deadline(&self) -> Option<Instant> {
        self.surface.local_deadline
    }

    /// Whether app code has requested an animation frame.
    pub fn frame_requested(&self) -> bool {
        self.surface.frame.is_some()
    }

    /// Whether native animations, animated images, or selection autoscroll are active.
    pub fn animating(&self) -> bool {
        self.tree.animator.animating()
            || self.selection.deadline().is_some()
            || self.images.is_animating(Instant::now(), &self.tree)
    }

    /// Handle to the running engine's control channel, if loaded.
    pub fn control(&self) -> Option<nsh_engine::EngineControl> {
        self.surface.control()
    }

    /// Grid cell metrics configured for this surface.
    pub fn cells(&self) -> CellSize {
        self.options.cells
    }

    /// Current logical viewport in NSH points.
    pub fn viewport(&self) -> Size<Points> {
        self.size()
    }

    /// Last rendered terminal cell buffer, including Sixel cell options.
    pub fn buffer(&self) -> &Buffer {
        &self.scratch
    }

    /// Most recent app error reported on this surface, if any.
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// Currently focused node identifier, if any.
    pub fn focused_node(&self) -> Option<nsh_core::NodeId> {
        self.keyboard.focused
    }

    /// Current native focus ancestry from focused leaf to `ROOT_ID`.
    pub fn focus_path(&self) -> Vec<nsh_core::NodeId> {
        if self.tree.dialogs.is_shown() || self.tree.menus.is_open() {
            return Vec::new();
        }
        self.keyboard.focus_path(&self.tree)
    }

    /// Current terminal cursor position for the active minibuffer or focused editable input.
    pub fn cursor_position(&self) -> Option<Position> {
        if !self.focused || self.tree.dialogs.is_shown() {
            return None;
        }
        self.minibuffer
            .cursor()
            .or_else(|| self.keyboard.cursor(&self.tree, &self.geometry))
    }

    /// Enqueues a synthetic [`nsh_core::MountBatch`] onto this surface's inbox.
    pub fn submit_batch(&self, batch: nsh_core::MountBatch) {
        self.surface.sink.send(Message::Batch(batch));
    }

    /// Returns the focused input's hints and current generation, redacting secure text.
    pub fn input_context(&self) -> Option<InputContext> {
        if self.tree.dialogs.is_shown() {
            return None;
        }
        let id = self.keyboard.focused?;
        let view = self.tree.get(id).filter(|v| v.kind == ViewKind::Input)?;
        let config = view.input.as_ref()?;
        let field = view.field.as_ref()?;
        let (start, end) = field.model.selection();
        let text = field.model.text();
        let selection = text_edit::byte_to_utf16(text, start)..text_edit::byte_to_utf16(text, end);
        Some(InputContext {
            node: id,
            text: (!config.secure).then(|| text.to_owned()),
            selection,
            event_count: field.count(),
            keyboard: config.keyboard,
            auto_capitalize: config.auto_capitalize,
            auto_correct: config.auto_correct,
            auto_fill: config.auto_fill,
            secure: config.secure,
            editable: config.editable,
            multiline: config.multiline,
            max_length: config.max_length,
        })
    }

    /// Semantic snapshot of visible accessible nodes in paint/tree order, scoped to the active modal.
    pub fn accessibility_snapshot(&self) -> Vec<AccessibleNode> {
        let scope = crate::navigation::focus_scope(&self.tree);
        let mut exposed = vec![false; self.tree.views.len()];
        let is_visible = |g: &crate::render::Geometry| {
            let host = self.tree.spans.get(&g.id).map_or(g.id, |span| span.view);
            crate::keyboard::input_scope(&self.tree, host) == scope
                && (!g.visible.is_empty()
                    || (self
                        .tree
                        .get(g.id)
                        .and_then(|v| v.input.as_ref())
                        .is_some_and(|c| c.editable && c.caret_hidden)
                        && crate::keyboard::sink_cursor(&self.tree, &self.geometry, g.id)
                            .is_some()))
        };
        for g in &self.geometry {
            if is_visible(g)
                && let Some(slot) = exposed.get_mut(g.id as usize)
            {
                *slot = true;
            }
        }
        self.geometry
            .iter()
            .filter(|g| is_visible(g))
            .filter_map(|g| {
                let id = g.id;
                if let Some(span) = self.tree.spans.get(&id) {
                    let mut anc = Some(span.view);
                    while let Some(aid) = anc {
                        let view = self.tree.get(aid)?;
                        if view.props.accessibility.hidden
                            || view.props.accessibility.accessible == Some(true)
                        {
                            return None;
                        }
                        anc = view.parent;
                    }
                    let text = &self.tree.get(span.view)?.text_content.as_ref()?.text;
                    let mut offset = 0u32;
                    let fallback: String = text
                        .chars()
                        .filter(|ch| {
                            let start = offset;
                            offset += ch.len_utf16() as u32;
                            start < span.range.end && offset > span.range.start
                        })
                        .collect();
                    return Some(AccessibleNode {
                        id,
                        frame: g.frame,
                        role: nsh_core::AccessibilityRole::Link,
                        label: plain(&fallback, true),
                        hint: None,
                        state: nsh_core::AccessibilityState::default(),
                        value: None,
                        focused: self.keyboard.focused == Some(id),
                        actions: Vec::new(),
                    });
                }
                let view = self.tree.get(id)?;
                let a = &view.props.accessibility;
                if a.hidden || a.accessible == Some(false) {
                    return None;
                }
                let mut parent = view.parent;
                while let Some(pid) = parent {
                    let ancestor = self.tree.get(pid)?;
                    if ancestor.props.accessibility.hidden
                        || ancestor.props.accessibility.accessible == Some(true)
                    {
                        return None;
                    }
                    parent = ancestor.parent;
                }
                let fallback = view
                    .text_content
                    .as_ref()
                    .map(|t| t.text.clone())
                    .unwrap_or_else(|| {
                        if view.kind == ViewKind::Input {
                            view.input
                                .as_ref()
                                .map(|c| c.placeholder.clone())
                                .unwrap_or_default()
                        } else {
                            String::new()
                        }
                    });
                let label = a.label.as_deref().map(str::to_owned).unwrap_or(fallback);
                let label = if label.is_empty() && a.accessible == Some(true) {
                    semantic_text(&self.tree, id, 0, &exposed)
                } else {
                    label
                };
                let secure = view.input.as_ref().is_some_and(|c| c.secure);
                if label.is_empty()
                    && a.role == nsh_core::AccessibilityRole::None
                    && view.kind != ViewKind::Input
                    && !view.events.contains(nsh_core::EventKind::Press)
                {
                    return None;
                }
                Some(AccessibleNode {
                    id,
                    frame: g.frame,
                    role: a.role,
                    label: plain(&label, true),
                    hint: a.hint.as_deref().map(|hint| plain(hint, true)),
                    state: a.state,
                    value: (!secure).then(|| a.value.clone()).flatten(),
                    focused: self.keyboard.focused == Some(id),
                    actions: a.actions.clone(),
                })
            })
            .collect()
    }

    /// Plain-text snapshot of the current terminal grid (with Sixel cells rendered as spaces).
    pub fn snapshot(&self) -> String {
        let area = self.scratch.area;
        let mut output = String::new();
        for row in 0..area.height {
            let y = area.y + row;
            let mut x = 0;
            let mut line = String::new();
            while x < area.width {
                let symbol = self.scratch[(area.x + x, y)].symbol();
                if symbol.contains('\x1b') {
                    line.push(' ');
                    x += 1;
                } else {
                    line.push_str(symbol);
                    x =
                        x.saturating_add(
                            unicode_width::UnicodeWidthStr::width(symbol).max(1) as u16
                        );
                }
            }
            output.push_str(line.trim_end());
            output.push('\n');
        }
        output
    }

    /// Connects to a development server, replacing the current app and connection.
    #[cfg(feature = "dev")]
    pub fn connect_dev_server(&mut self, url: impl Into<String>) -> io::Result<()> {
        self.stop();
        let url = url.into();
        self.dev_assets = dev::ServerAssets::for_server(&url)
            .map(|assets| Arc::new(assets) as Arc<dyn nsh_engine::Assets>);
        self.dev = Some(dev::DevSession::start(
            url,
            &self.options,
            self.surface.wake.clone(),
        )?);
        Ok(())
    }

    /// Selects the development log shown by `C-h e`; the file is read only while the panel is open.
    #[cfg(feature = "dev")]
    pub fn set_dev_log_path(&mut self, path: PathBuf) {
        self.diagnostics.log_path = Some(path);
    }

    /// Shows or hides the performance line. Hiding it drops all samples and timers.
    pub fn set_fps_monitor(&mut self, enabled: bool) {
        if enabled == self.perf.is_some() {
            return;
        }
        self.perf = enabled.then(crate::perf::Monitor::new);
        self.output.enabled.set(enabled);
        if let Some(control) = self.surface.control() {
            control.set_perf_monitor(self.perf.as_ref().map(|p| p.engine.clone()));
        }
        self.surface.wake.notify();
    }

    /// The shared engine monitor while the performance line is enabled.
    pub fn perf_monitor(&self) -> Option<Arc<nsh_engine::perf::PerfMonitor>> {
        self.perf.as_ref().map(|p| p.engine.clone())
    }

    /// Timings and output of the last completed `draw_terminal`, if monitoring is enabled.
    pub fn frame_metrics(&self) -> Option<crate::FrameMetrics> {
        self.perf.as_ref().and_then(|p| p.last)
    }

    /// Wraps the host's backend to count the actual Cell diff without scanning the buffer again.
    pub fn measure_backend<B>(&self, backend: B) -> crate::MeasuredBackend<B> {
        self.output.cells.set(Some(0));
        crate::MeasuredBackend {
            inner: backend,
            output: self.output.clone(),
        }
    }

    /// Wraps the terminal writer to count successful bytes, including escape sequences.
    pub fn measure_writer<W>(&self, writer: W) -> crate::MeasuredWriter<W> {
        self.output.bytes.set(Some(0));
        crate::MeasuredWriter {
            inner: writer,
            output: self.output.clone(),
        }
    }

    /// Draws a full-terminal surface and completes its optional performance sample after flushing.
    /// Embedders owning a larger layout may still use `render` or the Widget interface.
    pub fn draw_terminal<B: ratatui_core::backend::Backend>(
        &mut self,
        terminal: &mut ratatui_core::terminal::Terminal<B>,
    ) -> Result<(), B::Error> {
        if std::mem::take(&mut self.repaint) {
            terminal.clear()?;
        }
        if self.perf.is_none() {
            terminal.draw(|frame| self.render(frame, frame.area()))?;
            return Ok(());
        }
        let app_frame = self
            .surface
            .deadline()
            .is_some_and(|due| due <= Instant::now())
            || terminal.size()? != self.area.into();
        self.output.bytes.set(self.output.bytes.get().map(|_| 0));
        self.output.cells.set(self.output.cells.get().map(|_| 0));
        let mut flush = None;
        terminal.draw(|frame| {
            self.render(frame, frame.area());
            flush = Some(Instant::now());
        })?;
        let at = Instant::now();
        if let Some(perf) = &mut self.perf {
            let mut sample = perf.pending;
            sample.flush = at.duration_since(flush.unwrap());
            sample.bytes = self.output.bytes.get();
            sample.cells = self.output.cells.get();
            perf.finish(at, sample, app_frame);
        }
        Ok(())
    }

    /// The channel shared with the running app.
    pub fn host(&self) -> HostChannel {
        self.options.host.clone()
    }

    /// Registers an embedding app's component for subsequent mounts.
    pub fn register_component(
        &mut self,
        name: impl Into<String>,
        factory: ComponentFactory,
    ) -> Result<(), String> {
        let name = name.into();
        if nsh_core::platform::is_reserved_component(&name) {
            return Err("component names under nsh/ are reserved".into());
        }
        self.tree.components.insert(name, factory);
        Ok(())
    }

    /// Changes the appearance; its callback runs on the next render.
    pub fn set_appearance(&mut self, appearance: Appearance) {
        if self.options.appearance == appearance {
            return;
        }
        self.options.appearance = appearance;
        self.environment.color_scheme = appearance.resolve(self.options.capabilities.background);
        if let Some(control) = self.surface.control() {
            control.set_environment(self.environment);
        }
        self.appearance_changed = true;
        self.surface.wake.notify();
    }

    /// Gives or removes the surface's keyboard focus.
    pub fn set_focused(&mut self, focused: bool) {
        self.focused = focused;
        let lifecycle = if focused {
            nsh_core::platform::Lifecycle::Active
        } else {
            nsh_core::platform::Lifecycle::Inactive
        };
        if self.environment.lifecycle != lifecycle {
            self.environment.lifecycle = lifecycle;
            if let Some(control) = self.surface.control() {
                control.set_environment(self.environment);
            }
        }
        if !focused {
            self.minibuffer.end();
            self.field_drag = None;
            self.field_press = None;
            self.press_focus = None;
            self.bar_drag = None;
            self.selection.clear();
            let control = self.surface.control();
            self.keyboard.set_scope(None, &self.tree);
            if let Some(control) = &control {
                self.keyboard.focus(None, &mut self.tree, control);
                self.pointer.leave(&mut crate::input::PointerContext {
                    area: self.area,
                    cells: self.options.cells,
                    hits: &self.hits,
                    geometry: &self.geometry,
                    tree: &mut self.tree,
                    control,
                });
            }
            self.surface.wake.notify();
            self.pointer.cancel(&mut self.tree, control.as_ref());
        }
    }

    /// Receives app errors as text, during rendering on the embedder's thread.
    pub fn on_error(&mut self, callback: impl FnMut(&str) + 'static) {
        self.on_error = Some(Box::new(callback));
    }

    /// Receives structured app errors during rendering on the embedder's thread.
    pub fn on_app_error(&mut self, callback: impl FnMut(&AppError) + 'static) {
        self.on_app_error = Some(Box::new(callback));
    }

    /// Receives appearance changes during rendering on the embedder's thread.
    pub fn on_appearance_changed(&mut self, callback: impl FnMut(Appearance) + 'static) {
        self.on_appearance = Some(Box::new(callback));
    }

    /// The terminal cursor's shape the surface wants: a bar while a text
    /// field is edited, the user's own otherwise.
    pub fn cursor_style(&self) -> crate::CursorStyle {
        self.cursor_style
    }

    /// Receives cursor shape changes during rendering on the embedder's
    /// thread; hosts write the shape to the terminal (`CSI Ps SP q`).
    pub fn on_cursor_style_changed(&mut self, callback: impl FnMut(crate::CursorStyle) + 'static) {
        self.on_cursor_style = Some(Box::new(callback));
    }

    /// Replaces the scheduler notification. It must only enqueue work, never render on the engine thread.
    pub fn set_wake_callback(&mut self, callback: Option<WakeCallback>) {
        self.surface.wake.set(callback);
    }

    /// Earliest requested render, or no deadline while idle. Pending commits are due now.
    pub fn next_frame_deadline(&self) -> Option<Instant> {
        let mut deadline = self.surface.deadline();
        if let Some(due) = self.selection.deadline() {
            deadline = Some(deadline.map_or(due, |other| other.min(due)));
        }
        if let Some(due) = self.images.next_deadline(Instant::now(), &self.tree) {
            deadline = Some(deadline.map_or(due, |other| other.min(due)));
        }
        if let Some(refresh) = self.perf.as_ref().and_then(|p| p.refresh) {
            deadline = Some(deadline.map_or(refresh, |due| due.min(refresh)));
        }
        #[cfg(feature = "dev")]
        if self.diagnostics.open {
            return Some(deadline.map_or(self.diagnostics.refresh, |due| {
                due.min(self.diagnostics.refresh)
            }));
        }
        deadline
    }

    /// Whether app code requested exit. Standalone loops close; embedders decide their own response.
    pub fn exit_requested(&self) -> bool {
        self.tree.exit
    }

    /// Routes input against the last completed render. Unused keys and outside-area events are ignored.
    pub fn handle(&mut self, input: Input) -> Handled {
        let user_input = !matches!(input, Input::Focus(_));
        let focused_before = self.keyboard.focused;
        let handled = self.handle_inner(input);
        if user_input && self.keyboard.focused != focused_before {
            self.tree.focus_requests.retain(|&(_, focus)| !focus);
        }
        handled
    }

    fn handle_inner(&mut self, input: Input) -> Handled {
        if self.input_paused && !matches!(input, Input::Focus(_)) {
            return Handled::Ignored;
        }
        // Ctrl+C is never the diagnostics panel's: it copies or quits.
        #[cfg(feature = "dev")]
        let interrupt = matches!(&input, Input::Key { key, modifiers, .. }
            if key == "c" && modifiers.ctrl && !modifiers.alt && !modifiers.shift && !modifiers.cmd);
        #[cfg(feature = "dev")]
        if (self.dev.is_some() || self.diagnostics.log_path.is_some())
            && !interrupt
            && self.focused
            && (self.diagnostics.open
                || (self.editing_field().is_none() && !self.minibuffer.is_open()))
            && self.diagnostics.handle(&input)
        {
            let control = self.surface.control();
            self.pointer.cancel(&mut self.tree, control.as_ref());
            if std::mem::take(&mut self.diagnostics.toggle_perf) {
                self.set_fps_monitor(self.perf.is_none());
            }
            if self.diagnostics.reload {
                self.diagnostics.reload = false;
                if let Some(mut dev) = self.dev.take() {
                    dev.reload_latest(self);
                    self.dev = Some(dev);
                }
            }
            self.surface.wake.notify();
            return Handled::Yes;
        }
        if self.tree.dialogs.is_shown()
            && let Some(handled) = self.handle_dialog(&input)
        {
            return handled;
        }
        if let Input::Mouse(mouse) = &input {
            self.tree.menus.pointer = Some(Position::new(mouse.column, mouse.row));
        }
        // A press on the menu bar is the bar's, open or not.
        let on_bar = matches!(&input, Input::Mouse(mouse)
            if matches!(mouse.kind, crate::MouseKind::Down(_))
                && self.tree.menus.on_bar(Position::new(mouse.column, mouse.row)));
        if (self.tree.menus.is_open() || on_bar)
            && let Some(handled) = self.handle_menu(&input)
        {
            return handled;
        }
        if self.minibuffer.is_open() {
            match &input {
                Input::Paste(text) => {
                    self.search(|minibuffer, scene| minibuffer.paste(text, scene));
                    return Handled::Yes;
                }
                Input::Mouse(_) => {
                    self.minibuffer.end();
                    self.surface.wake.notify();
                }
                _ => {}
            }
        }
        match input {
            Input::Focus(focused) => {
                // The terminal may have drawn over the surface meanwhile.
                self.repaint |= focused && !self.focused;
                self.set_focused(focused);
                Handled::Yes
            }
            Input::Mouse(mouse) => {
                if matches!(mouse.kind, crate::MouseKind::Down(_)) {
                    self.pointer.count_click(mouse);
                }
                if let Some(handled) = self.handle_scrollbar(mouse) {
                    return handled;
                }
                if self.handle_field_mouse(mouse) {
                    self.selection.clear();
                    self.surface.wake.notify();
                    return Handled::Yes;
                }
                let Some(control) = self.surface.control() else {
                    return Handled::Ignored;
                };
                let scene = crate::selection::Scene {
                    area: self.area,
                    cells: self.options.cells,
                    hits: &self.hits,
                    geometry: &self.geometry,
                    tree: &self.tree,
                };
                if self.selection.handle(mouse, scene, self.pointer.clicks()) {
                    self.pointer.cancel(&mut self.tree, Some(&control));
                    self.keyboard.focus(None, &mut self.tree, &control);
                    self.surface.wake.notify();
                    return Handled::Yes;
                }
                if matches!(mouse.kind, crate::MouseKind::Down(crate::MouseButton::Left)) {
                    self.surface.wake.notify();
                }
                let handled = if matches!(
                    mouse.kind,
                    crate::MouseKind::Down(crate::MouseButton::Right)
                ) {
                    self.pointer.context_menu(
                        mouse,
                        &mut crate::input::PointerContext {
                            area: self.area,
                            cells: self.options.cells,
                            hits: &self.hits,
                            geometry: &self.geometry,
                            tree: &mut self.tree,
                            control: &control,
                        },
                    )
                } else if matches!(mouse.kind, crate::MouseKind::Wheel { .. }) {
                    let handled = self.keyboard.wheel(
                        mouse,
                        self.area,
                        self.options.cells,
                        &self.hits,
                        &mut self.tree,
                        &self.geometry,
                        &control,
                    );
                    if handled == Handled::Yes {
                        self.pointer.cancel(&mut self.tree, Some(&control));
                    }
                    handled
                } else {
                    self.pointer.handle(
                        mouse,
                        crate::input::PointerContext {
                            area: self.area,
                            cells: self.options.cells,
                            hits: &self.hits,
                            geometry: &self.geometry,
                            tree: &mut self.tree,
                            control: &control,
                        },
                    )
                };
                if handled == Handled::Yes {
                    self.surface.wake.notify();
                }
                handled
            }
            Input::Key {
                key,
                modifiers,
                release,
            } => {
                if release {
                    Handled::Ignored
                } else {
                    self.handle_key(&key, modifiers, false)
                }
            }
            Input::KeyRepeat { key, modifiers } => self.handle_key(&key, modifiers, true),
            Input::Paste(text) => {
                let Some(id) = self.editing_field() else {
                    return Handled::Ignored;
                };
                let Some(control) = self.surface.control() else {
                    return Handled::Ignored;
                };
                let view = self.tree.get_mut(id).unwrap();
                let events = view.events;
                view.field.as_mut().unwrap().paste(
                    view.input.as_ref().unwrap(),
                    events,
                    &text,
                    id,
                    &control,
                );
                self.surface.wake.notify();
                Handled::Yes
            }
        }
    }

    /// A shown system dialog is modal: it takes every key and press, and the
    /// app's views get no input until it is answered. Ctrl+C still quits (unless
    /// bound by an app fallback handler), and focus reports still reach the surface (`None`).
    fn handle_dialog(&mut self, input: &Input) -> Option<Handled> {
        let outcome = match input {
            Input::Focus(_) => return None,
            Input::Key {
                key,
                modifiers,
                release,
            } => {
                if *release || !self.focused {
                    return Some(Handled::Ignored);
                }
                if let Some(stroke) = crate::key_scheme::keystroke(key, *modifiers)
                    && let Some(crate::key_scheme::Action::Quit) =
                        crate::key_scheme::terminal(stroke)
                {
                    if let Some(control) = self.surface.control()
                        && self.keyboard.fallback_shortcut(
                            &self.tree,
                            stroke,
                            false,
                            self.options.capabilities.command_key,
                            &control,
                        )
                    {
                        self.surface.wake.notify();
                        return Some(Handled::Yes);
                    }
                    self.tree.exit = true;
                    return Some(Handled::Yes);
                }
                self.tree.dialogs.key(key, *modifiers)
            }
            Input::KeyRepeat { key, modifiers } => self.tree.dialogs.key(key, *modifiers),
            Input::Mouse(mouse) => {
                let crate::MouseKind::Down(_) = mouse.kind else {
                    return Some(Handled::Yes);
                };
                // Views behind the dialog lose a press or hover they held.
                let control = self.surface.control();
                self.pointer.cancel(&mut self.tree, control.as_ref());
                self.tree
                    .dialogs
                    .press(Position::new(mouse.column, mouse.row))
            }
            Input::Paste(_) => return Some(Handled::Yes),
        };
        if let Some(crate::dialog::Outcome::Answered(answer)) = outcome
            && let Some(control) = self.surface.control()
        {
            answer.dispatch(&control);
        }
        self.surface.wake.notify();
        Some(Handled::Yes)
    }

    /// An open context menu takes every key and press until it closes, as
    /// a system menu does; Ctrl+C still quits (unless bound by an app fallback
    /// handler), and focus reports still reach the surface (`None`).
    fn handle_menu(&mut self, input: &Input) -> Option<Handled> {
        let outcome = match input {
            Input::Focus(_) => return None,
            Input::Key {
                key,
                modifiers,
                release,
            } => {
                if *release || !self.focused {
                    return Some(Handled::Ignored);
                }
                if let Some(stroke) = crate::key_scheme::keystroke(key, *modifiers)
                    && let Some(crate::key_scheme::Action::Quit) =
                        crate::key_scheme::terminal(stroke)
                {
                    if let Some(control) = self.surface.control()
                        && self.keyboard.fallback_shortcut(
                            &self.tree,
                            stroke,
                            false,
                            self.options.capabilities.command_key,
                            &control,
                        )
                    {
                        self.tree.menus.clear();
                        self.surface.wake.notify();
                        return Some(Handled::Yes);
                    }
                    self.tree.exit = true;
                    return Some(Handled::Yes);
                }
                if self.tree.menus.bar_active()
                    && let Some(stroke) = crate::key_scheme::keystroke(key, *modifiers)
                {
                    let m = stroke.modifiers;
                    // tmux joins two quick Escapes into Alt+Escape.
                    if stroke.key == nsh_core::keymap::Key::Escape && m.alt && !m.ctrl && !m.cmd {
                        let outcome = self.tree.menus.key("Escape", Default::default());
                        if let Some(outcome) = outcome {
                            self.menu_chosen(&outcome);
                        }
                        self.surface.wake.notify();
                        return Some(Handled::Yes);
                    }
                    // A shortcut with a modifier chooses its item while the
                    // bar has the keys (a letter alone is a title's initial).
                    if (m.ctrl || m.alt || m.cmd) && self.menu_shortcut(stroke, false, true) {
                        self.surface.wake.notify();
                        return Some(Handled::Yes);
                    }
                }
                self.tree.menus.key(key, *modifiers)
            }
            Input::KeyRepeat { key, modifiers } => self.tree.menus.key(key, *modifiers),
            Input::Mouse(mouse) => {
                let position = Position::new(mouse.column, mouse.row);
                match mouse.kind {
                    crate::MouseKind::Down(_) => {
                        // Views behind the menu lose a press or hover they held.
                        let control = self.surface.control();
                        self.pointer.cancel(&mut self.tree, control.as_ref());
                        self.tree.menus.press(position)
                    }
                    crate::MouseKind::Move => self.tree.menus.hover(position),
                    _ => return Some(Handled::Yes),
                }
            }
            Input::Paste(_) => return Some(Handled::Yes),
        };
        if let Some(outcome) = outcome {
            self.menu_chosen(&outcome);
        }
        self.surface.wake.notify();
        Some(Handled::Yes)
    }

    /// Reports what a menu closed with, and carries out a chosen item's
    /// role: a quit or close role ends the app, an editing one is the
    /// focused field's (or the selection's) as its key is.
    fn menu_chosen(&mut self, outcome: &crate::menu::Outcome) {
        let Some(control) = self.surface.control() else {
            return;
        };
        if outcome.dispatch(&control) {
            self.tree.exit = true;
        }
        let (crate::menu::Outcome::Closed(Some((_, Some(role))))
        | crate::menu::Outcome::Left(Some((_, Some(role))))) = outcome
        else {
            return;
        };
        self.edit_role(*role);
    }

    /// An editing role (`copy`, `paste`, ...) chosen from a menu: the key
    /// a field or the selection takes for it, Command's.
    fn edit_role(&mut self, role: nsh_core::desktop::MenuRole) {
        use nsh_core::desktop::MenuRole;
        let (key, shift) = match role {
            MenuRole::Undo => ("z", false),
            MenuRole::Redo => ("z", true),
            MenuRole::Cut => ("x", false),
            MenuRole::Copy => ("c", false),
            MenuRole::Paste => ("v", false),
            MenuRole::SelectAll => ("a", false),
            _ => return,
        };
        let modifiers = crate::Modifiers {
            cmd: true,
            shift,
            ..Default::default()
        };
        self.handle_key(key, modifiers, false);
    }

    /// A shortcut of the application menu's items, after the app's own
    /// bindings: it chooses its item, unless a field being edited uses the
    /// keystroke itself.
    fn menu_shortcut(
        &mut self,
        stroke: nsh_core::keymap::Keystroke,
        repeat: bool,
        bar: bool,
    ) -> bool {
        use nsh_core::{desktop::Key, keymap::Key as K};
        let key = match stroke.key {
            K::Char(' ') => Key::Space,
            K::Char(c) => Key::Char(c),
            K::Enter => Key::Enter,
            K::Escape => Key::Escape,
            K::Tab => Key::Tab,
            K::Backspace => Key::Backspace,
            K::Delete => Key::Delete,
            K::Insert => Key::Insert,
            K::Up => Key::Up,
            K::Down => Key::Down,
            K::Left => Key::Left,
            K::Right => Key::Right,
            K::Home => Key::Home,
            K::End => Key::End,
            K::PageUp => Key::PageUp,
            K::PageDown => Key::PageDown,
            K::F(n) => Key::F(n),
        };
        let m = stroke.modifiers;
        let pressed = nsh_core::desktop::Shortcut {
            key,
            ctrl: m.ctrl,
            alt: m.alt,
            shift: m.shift,
            meta: m.cmd,
        };
        // A terminal that cannot report Cmd sends Ctrl for it on macOS, as
        // the keymap's `mod+` bindings take it (`Keyboard::shortcut`).
        let command = (!self.options.capabilities.command_key
            && OS == nsh_core::platform::Os::MacOs
            && pressed.ctrl
            && !pressed.meta)
            .then_some(nsh_core::desktop::Shortcut {
                ctrl: false,
                meta: true,
                ..pressed
            });
        let Some((id, role, fires)) = self
            .tree
            .menus
            .shortcut(&pressed)
            .or_else(|| command.and_then(|command| self.tree.menus.shortcut(&command)))
        else {
            return false;
        };
        // The edit roles' keys stay the field's and the selection's own
        // (Ctrl+C copies, or quits with nothing selected).
        if role.is_some_and(|role| {
            use nsh_core::desktop::MenuRole;
            matches!(
                role,
                MenuRole::Undo
                    | MenuRole::Redo
                    | MenuRole::Cut
                    | MenuRole::Copy
                    | MenuRole::Paste
                    | MenuRole::SelectAll
            )
        }) {
            return false;
        }
        if !bar && !fires && self.editing_field().is_some() {
            return false;
        }
        if !repeat {
            // Chosen from the bar, it folds the bar up.
            self.tree.menus.clear();
            self.menu_chosen(&crate::menu::Outcome::Left(Some((id, role))));
        }
        true
    }

    fn handle_key(&mut self, key: &str, modifiers: crate::Modifiers, repeat: bool) -> Handled {
        if !self.focused {
            return Handled::Ignored;
        }
        let Some(stroke) = crate::key_scheme::keystroke(key, modifiers) else {
            return Handled::Ignored;
        };
        let Some(control) = self.surface.control() else {
            // No app to ask: Ctrl+C still quits.
            if let Some(crate::key_scheme::Action::Quit) = crate::key_scheme::terminal(stroke) {
                self.tree.exit = true;
                return Handled::Yes;
            }
            return Handled::Ignored;
        };
        if self.minibuffer.is_open()
            && let Some(crate::search::Outcome::Consumed) =
                self.search(|minibuffer, scene| minibuffer.key(key, stroke, scene))
        {
            return Handled::Yes;
        }
        // F10 gives the menu bar the keys (the open bar takes the next).
        if stroke.key == nsh_core::keymap::Key::F(10)
            && stroke.modifiers == nsh_core::keymap::Modifiers::default()
            && let Some(outcome) = self.tree.menus.toggle_bar()
        {
            self.menu_chosen(&outcome);
            self.surface.wake.notify();
            return Handled::Yes;
        }
        self.catch_up_with_focus();
        let command_key = self.options.capabilities.command_key;
        let selecting = self.selection.is_active();
        let field_selected = self
            .editing_field()
            .and_then(|id| self.tree.get(id)?.field.as_ref())
            .is_some_and(|f| f.model.has_selection());
        let mut handled = if (self.editing_field().is_some()
            && !field_selected
            && self.selection.key_while_editing(
                key,
                modifiers,
                &self.tree,
                &self.geometry,
                self.clipboard.as_ref(),
            ))
            || self
                .keyboard
                .shortcut(&self.tree, stroke, repeat, command_key, &control)
            || self.menu_shortcut(stroke, repeat, false)
            || self.handle_field_key(key, stroke, &control)
            || self.selection.key(
                key,
                modifiers,
                &self.tree,
                &self.geometry,
                self.clipboard.as_ref(),
            )
            || crate::key_scheme::arrow(stroke).is_some_and(|arrow| {
                self.keyboard
                    .shortcut(&self.tree, arrow, repeat, command_key, &control)
            }) {
            Handled::Yes
        } else if let Some(crate::key_scheme::Action::Search(forward)) =
            crate::key_scheme::terminal(stroke)
        {
            self.search(|minibuffer, scene| minibuffer.start(forward, scene));
            Handled::Yes
        } else if let Some(action) = crate::key_scheme::terminal(stroke)
            .filter(|a| !matches!(a, crate::key_scheme::Action::Quit))
        {
            self.keyboard
                .action(action, &mut self.tree, &self.geometry, &control, modifiers)
        } else {
            Handled::Ignored
        };
        if handled == Handled::Ignored {
            if self
                .keyboard
                .fallback_shortcut(&self.tree, stroke, repeat, command_key, &control)
                || crate::key_scheme::arrow(stroke).is_some_and(|arrow| {
                    self.keyboard.fallback_shortcut(
                        &self.tree,
                        arrow,
                        repeat,
                        command_key,
                        &control,
                    )
                })
            {
                handled = Handled::Yes;
            } else if let Some(crate::key_scheme::Action::Quit) =
                crate::key_scheme::terminal(stroke)
            {
                handled = self.keyboard.action(
                    crate::key_scheme::Action::Quit,
                    &mut self.tree,
                    &self.geometry,
                    &control,
                    modifiers,
                );
            }
        }
        if handled == Handled::Yes || (selecting && !self.selection.is_active()) {
            self.surface.wake.notify();
        }
        handled
    }

    fn apply_batch(&mut self, batch: nsh_core::MountBatch) {
        #[cfg(feature = "dev")]
        let observed = self.test.as_ref().map(|test| {
            (
                test.model.clone(),
                nsh_core::MountBatch {
                    items: batch.items.clone(),
                },
            )
        });
        self.tree.apply(batch);
        if let Some(enabled) = self.tree.perf_monitor.take() {
            self.set_fps_monitor(enabled);
        }
        #[cfg(feature = "dev")]
        if let Some((model, batch)) = observed {
            model.apply(&batch);
        }
    }

    /// Waits a moment for the engine to run the last focus change, applying
    /// the batches it makes: the app's bindings that hold only while a
    /// control is focused (an editor's Tab) follow the focus in effects, so
    /// a key sent right after the change (Escape and Tab together) is
    /// matched against the new focus's keymap. Other messages wait for the
    /// next draw. An engine busy past the wait leaves the keymap as it is.
    fn catch_up_with_focus(&mut self) {
        if self.surface.is_local() {
            while !self.keyboard.is_caught_up() {
                if let Some(Runtime::Local(local)) = &mut self.surface.runtime {
                    self.surface.local_deadline = local.pump();
                }
                let mut progressed = false;
                while let Ok(message) = self.surface.inbox.try_recv() {
                    progressed = true;
                    match message {
                        Message::Batch(batch) => self.apply_batch(batch),
                        Message::Focused(moved) => self.keyboard.caught_up(moved),
                        other => self.surface.held.push_back(other),
                    }
                }
                if !progressed {
                    break;
                }
            }
            if !self.surface.held.is_empty() {
                self.surface.wake.notify();
            }
            return;
        }
        let deadline = Instant::now() + FOCUS_CATCH_UP;
        while !self.keyboard.is_caught_up() {
            match self.surface.inbox.recv_deadline(deadline) {
                Ok(Message::Batch(batch)) => self.apply_batch(batch),
                Ok(Message::Focused(moved)) => self.keyboard.caught_up(moved),
                Ok(message) => self.surface.held.push_back(message),
                Err(_) => break,
            }
        }
        if !self.surface.held.is_empty() {
            self.surface.wake.notify();
        }
    }

    fn search<R>(
        &mut self,
        act: impl FnOnce(&mut crate::search::Minibuffer, &mut crate::search::Scene) -> R,
    ) -> Option<R> {
        let control = self.surface.control()?;
        let mut scene = crate::search::Scene {
            tree: &mut self.tree,
            geometry: &self.geometry,
            keyboard: &mut self.keyboard,
            control: &control,
            cells: self.options.cells,
            area: self.area,
        };
        let result = act(&mut self.minibuffer, &mut scene);
        self.surface.wake.notify();
        Some(result)
    }

    fn editing_field(&self) -> Option<nsh_core::NodeId> {
        if !self.focused {
            return None;
        }
        let id = self.keyboard.focused?;
        let view = self.tree.get(id)?;
        (view.input.as_ref().is_some_and(|config| config.editable)
            && !view.props.accessibility.state.disabled)
            .then_some(id)
    }

    fn handle_field_key(
        &mut self,
        key: &str,
        stroke: nsh_core::keymap::Keystroke,
        control: &nsh_engine::EngineControl,
    ) -> bool {
        let Some(id) = self.editing_field() else {
            return false;
        };
        let view = self.tree.get_mut(id).unwrap();
        let events = view.events;
        let config = view.input.as_ref().unwrap();
        let field = view.field.as_mut().unwrap();
        // Ctrl+C copies a selection, as in the terminal's other programs;
        // without one it is the terminal's interrupt (the Key scheme's quit).
        let copy = stroke.key == nsh_core::keymap::Key::Char('c')
            && stroke.modifiers.ctrl
            && !stroke.modifiers.alt
            && !stroke.modifiers.shift
            && !stroke.modifiers.cmd;
        if copy && !field.model.has_selection() {
            return false;
        }
        let action = if copy {
            Some(crate::key_scheme::EditAction::Copy)
        } else {
            crate::key_scheme::editing(stroke, config.multiline)
        };
        if let Some(action) = action {
            if field.edit(
                action,
                stroke.modifiers.shift,
                crate::text_input::EditContext {
                    config,
                    events,
                    kill: &mut self.kill,
                    clipboard: self.clipboard.as_ref(),
                    id,
                    control,
                },
            ) {
                self.keyboard.set_scope(None, &self.tree);
                self.keyboard.focus(None, &mut self.tree, control);
            }
            true
        } else if !stroke.modifiers.ctrl
            && !stroke.modifiers.alt
            && !stroke.modifiers.cmd
            && matches!(stroke.key, nsh_core::keymap::Key::Char(_))
        {
            field.insert(config, key, true, id, control);
            true
        } else {
            false
        }
    }

    /// Presses and drags on the scroll bars of the last render: a press on
    /// a track jumps there, the thumb follows the pointer while it is held.
    fn handle_scrollbar(&mut self, mouse: crate::MouseInput) -> Option<Handled> {
        use crate::{MouseButton, MouseKind};
        if let Some(drag) = &self.bar_drag {
            match mouse.kind {
                MouseKind::Move => {
                    if drag.moved(mouse, &mut self.tree) {
                        self.surface.wake.notify();
                    }
                    return Some(Handled::Yes);
                }
                MouseKind::Up(MouseButton::Left) => {
                    self.bar_drag = None;
                    return Some(Handled::Yes);
                }
                _ => self.bar_drag = None,
            }
        }
        let position = Position::new(mouse.column, mouse.row);
        if !self.area.contains(position) {
            return None;
        }
        if !matches!(mouse.kind, MouseKind::Down(MouseButton::Left)) {
            return None;
        }
        let bars = self.tree.scroll_bars.clone();
        let control = self.surface.control();
        let drag = crate::input::BarDrag::press(&bars, mouse, &mut self.tree)?;
        if let Some(control) = control.as_ref() {
            crate::keyboard::scroll_intent(&self.tree, drag.node, "scroll", control);
        }
        self.pointer.cancel(&mut self.tree, control.as_ref());
        self.selection.clear();
        self.minibuffer.end();
        self.bar_drag = Some(drag);
        self.surface.wake.notify();
        Some(Handled::Yes)
    }

    fn handle_field_mouse(&mut self, mouse: crate::MouseInput) -> bool {
        use crate::{MouseButton, MouseKind};
        let Some(control) = self.surface.control() else {
            return false;
        };
        let position = Position::new(mouse.column, mouse.row);
        let scope = crate::navigation::focus_scope(&self.tree);
        if matches!(mouse.kind, MouseKind::Up(MouseButton::Left))
            && let Some((mut press, origin, cells)) = self.field_press.take()
        {
            let page = crate::input::page_point(mouse, self.area, self.options.cells);
            let fire = self.tree.get(press.node).is_some() && cells.contains(position);
            for event in press.press_out(fire) {
                crate::input::dispatch(&control, &press, event, page, origin);
            }
        }
        // The stop pressed takes the focus as the press comes up, before
        // the press reaches it (what it opens gives the focus back there).
        if matches!(mouse.kind, MouseKind::Up(MouseButton::Left))
            && let Some(stop) = self.press_focus.take()
            && self.keyboard.focused != Some(stop)
            && self
                .keyboard
                .candidates(&self.tree, &self.geometry)
                .iter()
                .any(|g| g.id == stop)
        {
            self.keyboard.focus(Some(stop), &mut self.tree, &control);
            self.surface.wake.notify();
        }
        if let Some(FieldDrag {
            id,
            last,
            clicks,
            anchor,
        }) = self.field_drag
        {
            if self.keyboard.focused != Some(id)
                || !crate::keyboard::contains(&self.tree, scope, id)
            {
                self.field_drag = None;
            } else if matches!(
                mouse.kind,
                MouseKind::Move | MouseKind::Up(MouseButton::Left)
            ) {
                if position != last
                    && let Some(view) = self.tree.get_mut(id)
                {
                    let field = view.field.as_mut().unwrap();
                    field.drag(view.input.as_ref().unwrap(), position, clicks, anchor);
                    field.report(id, &control, false);
                }
                self.field_drag = if matches!(mouse.kind, MouseKind::Up(_)) {
                    None
                } else {
                    Some(FieldDrag {
                        id,
                        last: position,
                        clicks,
                        anchor,
                    })
                };
                return true;
            }
        }
        if !matches!(mouse.kind, MouseKind::Down(MouseButton::Left))
            || !self.area.contains(position)
        {
            return false;
        }
        let hit = self.hits.iter().rev().find(|hit| {
            hit.area.contains(position) && crate::keyboard::contains(&self.tree, scope, hit.node)
        });
        let id = hit.map(|hit| hit.node).filter(|&id| {
            self.tree.get(id).is_some_and(|view| {
                view.input.as_ref().is_some_and(|config| config.editable)
                    && !view.props.accessibility.state.disabled
            })
        });
        self.press_focus = None;
        if let Some(id) = id {
            // The press still goes down as a touch, so open popovers hear a
            // press outside them, then the field takes the pointer.
            self.pointer.handle(
                mouse,
                crate::input::PointerContext {
                    area: self.area,
                    cells: self.options.cells,
                    hits: &self.hits,
                    geometry: &self.geometry,
                    tree: &mut self.tree,
                    control: &control,
                },
            );
            // A field that listens to presses keeps the one the pointer
            // started on it: `onPressDown` went, `onPress` follows on the
            // way up, after the focus the field takes now.
            let press = self.pointer.take_press(id);
            self.pointer.cancel(&mut self.tree, Some(&control));
            self.keyboard.focus(Some(id), &mut self.tree, &control);
            self.field_press = press.map(|(press, origin)| {
                (press, origin, hit.map(|hit| hit.area).unwrap_or_default())
            });
            let clicks = self.pointer.clicks();
            let view = self.tree.get_mut(id).unwrap();
            let field = view.field.as_mut().unwrap();
            let anchor = field.click(
                view.input.as_ref().unwrap(),
                position,
                mouse.modifiers.shift,
                clicks,
            );
            field.report(id, &control, false);
            self.field_drag = Some(FieldDrag {
                id,
                last: position,
                clicks: if mouse.modifiers.shift { 1 } else { clicks },
                anchor,
            });
            true
        } else {
            // A press on a stop, or on what is inside one, gives it the
            // focus as it comes up (Tab goes on from there), as a click
            // does in terminal apps; one on nothing Tab stops at leaves a
            // field.
            // The view on top first, then what is under it: a stop over
            // the view pressed (a table's hit layer over its rows) is the
            // one under the pointer too.
            let stop = self
                .hits
                .iter()
                .rev()
                .filter(|hit| {
                    hit.area.contains(position)
                        && crate::keyboard::contains(&self.tree, scope, hit.node)
                })
                .find_map(|hit| {
                    self.keyboard
                        .pressed_stop(hit.node, &self.tree, &self.geometry)
                });
            self.press_focus = stop;
            if stop.is_none() {
                self.keyboard.set_scope(hit.map(|h| h.node), &self.tree);
                if self.editing_field().is_some() {
                    self.keyboard.focus(None, &mut self.tree, &control);
                    self.surface.wake.notify();
                }
            } else {
                self.keyboard.set_scope(None, &self.tree);
            }
            false
        }
    }

    /// Applies complete pending batches, resizes to `area`, and draws into the frame.
    pub fn render(&mut self, frame: &mut Frame, area: Rect) {
        self.draw(area, frame.buffer_mut());
        #[cfg(feature = "dev")]
        if self.diagnostics.open {
            self.set_cursor_style(crate::CursorStyle::Default);
            return;
        }
        let mut style = crate::CursorStyle::Default;
        if self.focused {
            if let Some(cursor) = self.minibuffer.cursor() {
                frame.set_cursor_position(cursor);
            } else if let Some(cursor) = self.keyboard.cursor(&self.tree, &self.geometry) {
                frame.set_cursor_position(cursor);
                style = crate::CursorStyle::Bar;
            }
        }
        self.set_cursor_style(style);
    }

    fn set_cursor_style(&mut self, style: crate::CursorStyle) {
        if self.cursor_style != style {
            self.cursor_style = style;
            if let Some(callback) = &mut self.on_cursor_style {
                callback(style);
            }
        }
    }

    fn size(&self) -> Size<Points> {
        Size::new(
            self.options.cells.width() * f32::from(self.area.width),
            self.options.cells.height() * f32::from(self.area.height),
        )
    }

    fn draw(&mut self, area: Rect, buffer: &mut Buffer) {
        let advance_frame = !self.surface.is_local();
        let _ = self.draw_scene(area, buffer, advance_frame);
        self.sync_scratch(area, buffer);
    }

    fn sync_scratch(&mut self, area: Rect, buffer: &Buffer) {
        let clip = area.intersection(buffer.area);
        if self.scratch.area != clip {
            self.scratch = Buffer::empty(clip);
        } else {
            self.scratch.reset();
        }
        for y in clip.top()..clip.bottom() {
            for x in clip.left()..clip.right() {
                self.scratch[(x, y)] = buffer[(x, y)].clone();
            }
        }
    }

    fn report_error(&mut self, error: AppError, text: &str) {
        #[cfg(feature = "dev")]
        if let Some(test) = &self.test {
            test.model.error(text.to_owned());
        }
        #[cfg(feature = "dev")]
        if self.dev.is_some() || self.diagnostics.log_path.is_some() {
            self.diagnostics.error("App error", text);
        }
        if let Some(callback) = &mut self.on_error {
            callback(text);
        }
        if let Some(callback) = &mut self.on_app_error {
            callback(&error);
        }
    }

    fn draw_scene(
        &mut self,
        area: Rect,
        buffer: &mut Buffer,
        advance_frame: bool,
    ) -> Option<String> {
        let started = self.perf.as_ref().map(|_| Instant::now());
        // The application menu's bar is the top row; the app has the rows
        // below it (all of them while the bar hides itself).
        let reserved = self.tree.menus.reserves_row() && area.height > 1;
        self.tree
            .menus
            .set_bar_row(Rect::new(area.x, area.y, area.width, area.height.min(1)));
        let area = if reserved {
            Rect::new(area.x, area.y + 1, area.width, area.height - 1)
        } else {
            area
        };
        if advance_frame {
            self.surface.begin_frame();
        } else {
            self.surface.wake.pending.store(false, Ordering::Release);
        }
        #[cfg(feature = "dev")]
        if let Some(mut dev) = self.dev.take() {
            while let Ok(event) = dev.inbox.try_recv() {
                match event {
                    dev::Message::Event(event) => dev.event(self, *event),
                    dev::Message::Test(test) => self.test = Some(test),
                }
            }
            self.dev = Some(dev);
        }
        if self.area != area {
            let control = self.surface.control();
            self.pointer.cancel(&mut self.tree, control.as_ref());
            self.area = area;
            self.environment.window = self.size();
            if let Some(control) = control {
                control.resize(self.size());
                control.set_environment(self.environment);
            }
            if self.surface.is_local() {
                self.surface.laid_out = self.size();
            }
        }
        let mut first_error = None;
        while let Some(message) = self
            .surface
            .held
            .pop_front()
            .or_else(|| self.surface.inbox.try_recv().ok())
        {
            match message {
                Message::Batch(batch) => self.apply_batch(batch),
                Message::Error(error) => {
                    let text = error.to_string();
                    if first_error.is_none() {
                        self.last_error = Some(text.clone());
                        first_error = Some(text.clone());
                    }
                    self.report_error(error, &text);
                }
                Message::Frame => self.surface.request_frame(),
                Message::Resized(size) => self.surface.laid_out = size,
                Message::Focused(moved) => self.keyboard.caught_up(moved),
                Message::ImageProgress {
                    id,
                    load_id,
                    loaded,
                    total,
                } => {
                    let events = self
                        .tree
                        .get(id)
                        .map_or_else(Default::default, |v| v.events);
                    let control = self.surface.control();
                    self.images
                        .on_progress(id, load_id, loaded, total, events, control.as_ref());
                }
                Message::ImageLoaded {
                    id,
                    load_id,
                    result,
                } => {
                    let (mount, events) = self
                        .tree
                        .get(id)
                        .map(|v| (v.image.clone(), v.events))
                        .unwrap_or_default();
                    let control = self.surface.control();
                    let _ = self.images.on_loaded(
                        id,
                        load_id,
                        result,
                        mount.as_ref(),
                        events,
                        control.as_ref(),
                    );
                }
                Message::ImageInfo { request_id, result } => {
                    let control = self.surface.control();
                    crate::image::send_image_info(control.as_ref(), request_id, result);
                }
                Message::SixelEncoded { id, key, sixel } => {
                    let _ = self.images.on_sixel_encoded(id, key, sixel);
                }
                #[cfg(feature = "dev")]
                Message::Reload => {
                    if let Some(mut dev) = self.dev.take() {
                        dev.reload(self);
                        self.dev = Some(dev);
                    }
                }
            }
        }
        for id in std::mem::take(&mut self.tree.removed_images) {
            self.images.remove(id);
        }
        let dirty_images = std::mem::take(&mut self.tree.dirty_images);
        if !dirty_images.is_empty() {
            let control = self.surface.control();
            let cells = self.options.cells;
            for id in dirty_images {
                if let Some(view) = self.tree.get(id) {
                    self.images.sync_view(
                        id,
                        view.image.as_ref(),
                        view.frame.size,
                        view.events,
                        cells,
                        &self.surface.sink,
                        control.as_ref(),
                    );
                } else {
                    self.images.remove(id);
                }
            }
        }
        let image_infos = std::mem::take(&mut self.tree.image_infos);
        if !image_infos.is_empty() {
            let control = self.surface.control();
            for (request_id, uri) in image_infos {
                self.images
                    .image_info(request_id, &uri, &self.surface.sink, control.as_ref());
            }
        }
        if self.tree.menus.reserves_row() != reserved {
            // The bar came or went: the app is laid out again for its rows.
            self.surface.wake.notify();
        }
        self.selection.autoscroll(
            &mut self.tree,
            self.area,
            self.options.cells,
            &self.geometry,
        );
        if let Some(control) = self.surface.control() {
            for &id in &self.tree.scrolled {
                if let Some(view) = self.tree.get(id)
                    && let Some(scroll) = &view.scroll
                {
                    control.scroll(id, scroll.reported(view.frame.size), scroll.applied);
                }
            }
        }
        // A scroll view's offset feeds the animation graph's scroll values
        // (a looping carousel's runway follows it), as on every platform; a
        // terminal's scrolling is instant, so it comes to rest as soon as
        // no drag holds it.
        for &id in &self.tree.scrolled {
            if let Some(view) = self.tree.get(id)
                && let Some(scroll) = &view.scroll
            {
                let offset = scroll.reported(view.frame.size);
                self.tree.animator.scrolled(id, offset);
                if !self.unsettled.contains(&id) {
                    self.unsettled.push(id);
                }
            }
        }
        self.tree.scrolled.clear();
        if !self.pointer.dragging() && self.bar_drag.is_none() {
            for id in std::mem::take(&mut self.unsettled) {
                if self.tree.animator.scroll_ended(id) {
                    self.surface.request_frame();
                }
            }
        }
        if let Some(control) = self.surface.control() {
            for _ in 0..std::mem::take(&mut self.tree.back_requests) {
                crate::navigation::back(&mut self.tree, &control, false);
            }
        }
        if let Some(appearance) = self.tree.appearance.take() {
            self.set_appearance(appearance);
        }
        if self.appearance_changed {
            self.appearance_changed = false;
            if let Some(callback) = &mut self.on_appearance {
                callback(self.options.appearance);
            }
        }
        let size = self.size();
        if let Some(root) = self.tree.get_mut(ROOT_ID) {
            root.frame = Bounds::new(Default::default(), size);
        }
        if let Some(control) = self.surface.control() {
            crate::navigation::report_shown(&mut self.tree, &control);
        }
        let capabilities = &self.options.capabilities;
        // The terminal's own colors give its surfaces (OSC 11 and 10, at
        // 256 colors or more); the bandless look elsewhere.
        let ramp = crate::palette::Ramp::new(
            capabilities.colors,
            capabilities.background_color,
            capabilities.foreground_color,
        );
        // An app loaded before the surface had a size starts laid out for
        // no room, every view at the origin: its views show from the layout
        // at the drawn area on, which the engine reports a turn or two later.
        let mut drawing = None;
        if (self.surface.runtime.is_none() || self.surface.sized()) && !area.is_empty() {
            self.surface.animate(&mut self.tree);
            drawing = started.map(|start| {
                let now = Instant::now();
                if let Some(perf) = &mut self.perf {
                    perf.pending.apply = now.duration_since(start);
                }
                now
            });
            let page =
                crate::palette::Ground::page(self.environment.color_scheme, capabilities.colors)
                    .with_ramp(ramp);
            let bands = crate::palette::Bands::new(
                self.environment.color_scheme,
                capabilities.colors,
                capabilities.background_color,
                capabilities.foreground_color,
            );
            let look = render::Look {
                cells: self.options.cells,
                page,
                bands,
            };
            render::draw(
                &mut self.tree,
                &mut self.images,
                &self.surface.sink,
                buffer,
                area,
                look,
                &mut self.hits,
                &mut self.geometry,
            );
            let scene = crate::selection::Scene {
                area,
                cells: self.options.cells,
                hits: &self.hits,
                geometry: &self.geometry,
                tree: &self.tree,
            };
            self.selection.draw(scene, buffer);
            let changes = self.selection.changes(&self.tree, &self.geometry);
            if let Some(control) = self.surface.control() {
                for (id, text, start) in changes {
                    control.dispatch_event(
                        id,
                        nsh_core::EventKind::SelectionChange,
                        nsh_core::EventPayload::Map(vec![
                            ("text", nsh_core::PayloadValue::Str(text)),
                            ("start", nsh_core::PayloadValue::Number(f64::from(start))),
                        ]),
                    );
                }
            }
            // A view that moved under the pointer, or away from it, is drawn
            // again in its new hover state.
            if let Some(control) = self.surface.control()
                && self.pointer.rehover(&mut crate::input::PointerContext {
                    area,
                    cells: self.options.cells,
                    hits: &self.hits,
                    geometry: &self.geometry,
                    tree: &mut self.tree,
                    control: &control,
                })
            {
                self.surface.wake.notify();
            }
            if let Some(control) = self.surface.control()
                && self
                    .keyboard
                    .reconcile(&mut self.tree, &self.geometry, &control)
            {
                self.surface.wake.notify();
            }
            if let Some(control) = self.surface.control() {
                let scope = crate::navigation::focus_scope(&self.tree);
                let mut keep = Vec::new();
                for (id, focus) in std::mem::take(&mut self.tree.focus_requests) {
                    // A target scrolled out of sight is focused and revealed,
                    // as keyboard navigation reveals what it moves to.
                    let target = focus
                        .then(|| {
                            self.keyboard
                                .candidates(&self.tree, &self.geometry)
                                .iter()
                                .find(|g| g.id == id)
                                .map(|g| g.frame)
                        })
                        .flatten();
                    if let Some(frame) = target {
                        keep.clear();
                        self.keyboard.focus(Some(id), &mut self.tree, &control);
                        crate::keyboard::reveal_frame(&mut self.tree, &self.geometry, id, frame);
                        self.surface.wake.notify();
                    } else if !focus && self.keyboard.focused == Some(id) {
                        self.keyboard.set_scope(None, &self.tree);
                        self.keyboard.focus(None, &mut self.tree, &control);
                        self.surface.wake.notify();
                    } else if focus
                        && crate::keyboard::contains(&self.tree, nsh_core::ROOT_ID, id)
                        && crate::keyboard::input_scope(&self.tree, id) == scope
                        && crate::keyboard::covering_root(&self.tree, &self.geometry, id).is_none()
                        && self.tree.get(id).is_some_and(|view| {
                            view.props.accessibility.state.disabled
                                || view.input.as_ref().is_some_and(|config| !config.editable)
                                || !self.geometry.iter().any(|g| {
                                    g.id == id
                                        && g.bounds.right > g.bounds.left
                                        && g.bounds.bottom > g.bounds.top
                                })
                        })
                    {
                        keep.retain(|&(pending, _)| pending != id);
                        keep.push((id, true));
                    }
                }
                self.tree.focus_requests.extend(keep);
                if let Some(id) = self.keyboard.focused
                    && let Some(field) = self.tree.get_mut(id).and_then(|view| view.field.as_mut())
                {
                    field.report(id, &control, false);
                }
            }
        }
        self.tree.menus.draw_bar(buffer, ramp);
        self.minibuffer
            .draw(&self.tree, &self.geometry, self.options.cells, area, buffer);
        #[cfg(feature = "dev")]
        self.diagnostics.draw(area, buffer);
        if self.options.capabilities.colors == ColorDepth::Monochrome {
            crate::palette::strip_colors(buffer, area);
        }
        if let (Some(drawing), Some(perf)) = (drawing, &mut self.perf) {
            perf.pending.draw = drawing.elapsed();
            perf.draw(area, buffer);
        }
        #[cfg(feature = "dev")]
        {
            let requests: Vec<_> = self
                .test
                .as_ref()
                .map(|test| test.inbox.try_iter().collect())
                .unwrap_or_default();
            for request in requests {
                request(self, buffer);
            }
        }
        first_error
    }

    /// Stops the engine, drops queued commits, and clears the surface's app-owned state.
    pub fn stop(&mut self) {
        #[cfg(feature = "dev")]
        {
            self.dev = None;
            self.test = None;
            let log_path = self.diagnostics.log_path.take();
            self.diagnostics = dev::Diagnostics::default();
            self.diagnostics.log_path = log_path;
        }
        self.stop_engine();
    }

    fn stop_engine(&mut self) {
        let control = self.surface.control();
        self.pointer.cancel(&mut self.tree, control.as_ref());
        self.selection.clear();
        self.pointer = Pointer::default();
        self.surface.stop();
        self.tree.clear();
        self.images.clear();
        self.hits.clear();
        self.geometry.clear();
        self.keyboard = Default::default();
        self.minibuffer = Default::default();
        self.kill.clear();
        self.field_drag = None;
        self.field_press = None;
        self.press_focus = None;
        self.last_error = None;
    }
}

fn plain(text: &str, lines: bool) -> String {
    text.chars()
        .filter(|ch| !ch.is_control() || (lines && matches!(ch, '\n' | '\t')))
        .collect()
}

fn semantic_text(tree: &Mounter, id: nsh_core::NodeId, depth: usize, exposed: &[bool]) -> String {
    if depth > 128 || !exposed.get(id as usize).copied().unwrap_or(false) {
        return String::new();
    }
    let Some(view) = tree.get(id) else {
        return String::new();
    };
    if view.props.accessibility.hidden || view.input.as_ref().is_some_and(|c| c.secure) {
        return String::new();
    }
    let mut text = view
        .text_content
        .as_ref()
        .map(|t| t.text.clone())
        .unwrap_or_default();
    for &child in &view.children {
        let child = semantic_text(tree, child, depth + 1, exposed);
        if !child.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&child);
        }
    }
    text
}

/// A primary press held in a text field: where it was last, its clicks and
/// the unit (character, word, line) it pressed, which its drag extends.
#[derive(Clone, Copy)]
struct FieldDrag {
    id: nsh_core::NodeId,
    last: Position,
    clicks: u32,
    anchor: (usize, usize),
}

impl Widget for &mut AppView {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        self.draw(area, buffer);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    use nsh_base::rich_editor::view::rich_editor;
    use nsh_core::prelude::*;
    use ratatui_core::{backend::TestBackend, terminal::Terminal};

    use crate::{App, AppOptions, AppView, Handled, Input, Modifiers, Root};

    fn test_surface() -> (AppView, crossbeam_channel::Receiver<()>) {
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut options = AppOptions::default();
        options.wake = Some(Arc::new(move || {
            let _ = tx.send(());
        }));
        options.cache = nsh_engine::CacheOptions::off();
        (AppView::new(options), rx)
    }

    fn draw_until(
        view: &mut AppView,
        terminal: &mut Terminal<TestBackend>,
        rx: &crossbeam_channel::Receiver<()>,
        expected: &str,
    ) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            terminal
                .draw(|frame| view.render(frame, frame.area()))
                .unwrap();
            let contents: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|c| c.symbol())
                .collect();
            if contents.contains(expected) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "expected {expected:?}, got {contents:?}"
            );
            let due = view
                .next_frame_deadline()
                .map_or(deadline, |due| due.min(deadline));
            let _ = rx.recv_deadline(due);
        }
    }

    #[component]
    fn DelayedComposer() -> impl IntoElement {
        let editable = signal(false);
        let focused = signal("none");
        let enable = editable;
        view()
            .flex_1()
            .child(text(move || {
                format!("editable:{} focus:{}", editable.get(), focused.get())
            }))
            .child(
                view()
                    .h(px(16.0))
                    .label("Enable")
                    .on_focus(move |_: &()| focused.set("enable"))
                    .on_press(move |_: &()| enable.set(true))
                    .child(text("Enable")),
            )
            .child(
                rich_editor()
                    .auto_focus(true)
                    .editable(move || editable.get())
                    .accessibility_label(Some(SharedString::from("Message composer")))
                    .on_focus(move |_: &()| focused.set("composer"))
                    .flex_1(),
            )
    }

    #[test]
    fn pending_autofocus_waits_for_editable_sink_unless_user_navigates() {
        // 1. Intermediate render while read-only retains pending focus until editable flips true.
        let (mut view, rx) = test_surface();
        let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
        view.load(App::Rust(Root::new::<DelayedComposer>(|| ())))
            .unwrap();
        draw_until(&mut view, &mut terminal, &rx, "editable:false focus:none");
        // Wait for RichEditor's spawned `rv.focus()` command batch and render while still read-only.
        let _ = rx.recv_timeout(Duration::from_millis(50));
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        assert!(view.input_context().is_none());

        // Trigger Enable via accessibility Press action (without moving keyboard focus),
        // simulating an async host state update flipping `editable` to `true`.
        let enable_id = view
            .accessibility_snapshot()
            .iter()
            .find(|node| node.label == "Enable")
            .unwrap()
            .id;
        view.control().unwrap().dispatch_event(
            enable_id,
            nsh_core::EventKind::Press,
            nsh_core::EventPayload::None,
        );
        draw_until(
            &mut view,
            &mut terminal,
            &rx,
            "editable:true focus:composer",
        );
        assert!(view.input_context().is_some_and(|ctx| ctx.editable));
        assert_eq!(
            view.handle(Input::Key {
                key: "H".into(),
                modifiers: Modifiers::default(),
                release: false,
            }),
            Handled::Yes
        );
        assert_eq!(
            view.handle(Input::Key {
                key: "i".into(),
                modifiers: Modifiers::default(),
                release: false,
            }),
            Handled::Yes
        );
        draw_until(&mut view, &mut terminal, &rx, "Hi");

        // 2. Explicit user Tab navigation before editable flips true cancels the pending focus.
        let (mut view, rx) = test_surface();
        let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
        view.load(App::Rust(Root::new::<DelayedComposer>(|| ())))
            .unwrap();
        draw_until(&mut view, &mut terminal, &rx, "editable:false focus:none");
        let _ = rx.recv_timeout(Duration::from_millis(50));
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        assert_eq!(
            view.handle(Input::Key {
                key: "Tab".into(),
                modifiers: Modifiers::default(),
                release: false,
            }),
            Handled::Yes
        );
        draw_until(&mut view, &mut terminal, &rx, "editable:false focus:enable");
        let enable_id = view
            .accessibility_snapshot()
            .iter()
            .find(|node| node.label == "Enable")
            .unwrap()
            .id;
        view.control().unwrap().dispatch_event(
            enable_id,
            nsh_core::EventKind::Press,
            nsh_core::EventPayload::None,
        );
        draw_until(&mut view, &mut terminal, &rx, "editable:true focus:enable");
        assert!(view.input_context().is_none());
    }
}
