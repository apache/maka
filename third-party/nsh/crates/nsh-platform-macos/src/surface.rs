//! One surface: an engine thread and the views it mounts on the main
//! thread.
//!
//! The engine thread hands each commit to [`Sink`], which queues it and
//! wakes the main thread once (`DispatchQueue::main`); the main thread
//! drains the queue and applies every batch in order ([`Surface::drain`]).
//! Native animations and JS frame requests run on one display link while
//! there is something to do. It drives every window of the surface, the
//! app's own too, and AppKit fires a view's link only while some of the
//! view's window shows on a screen, so it is made from the root view of a
//! window that shows ([`crate::window::link_root`]): the main window's
//! while it shows, else that of a window of the app's own; it moves when
//! that window hides, closes, is minimized or covered
//! ([`Surface::follow_windows`]). While native animations or the
//! platform's own (scroll glides) run, batches wait for the start of the
//! next frame and each frame applies them for at most
//! [`FRAME_BATCHES`] ([`Surface::apply_queued`]): a scroll glide's frames
//! are not delayed by batches landing between them, and several batches
//! (list binds while scrolling) spread over frames instead of one frame
//! taking them all. An idle surface applies a batch as soon as it lands.
//!
//! The one exception to "the main thread never waits for JS": when the
//! window resizes the root ([`Surface::resized`]), the main thread waits
//! for the engine's layout at the new size, at most [`RESIZE_WAIT`], and
//! applies it before AppKit draws the window at that size. Without it the
//! content shows a frame late during a live resize, and not at all during
//! AppKit's animated resizes (zoom, full screen): those run the run loop
//! in a private mode (`_NSMoveTimerRunLoopMode`) where the main queue
//! does not drain, so the window grew around stale content and showed its
//! background in the new area until the animation ended. An engine that
//! misses the deadline (JS busy) is not waited for again until it catches
//! up, so a slow app resizes as before, a frame or more behind.

use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    path::PathBuf,
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use crossbeam_channel::{Receiver, Sender};
use dispatch2::{DispatchQueue, DispatchQueueGlobalPriority, GlobalQueueIdentifier};
use nsh_core::{EventKind, EventPayload, MountBatch, MountItem, NodeId, Points, ROOT_ID, Size};
use nsh_engine::{
    Chunk, Engine, EngineConfig, EngineControl, Environment, MainThreadTask, MountSink,
    perf::PerfMonitor,
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, sel,
};
use objc2_foundation::{NSObject, NSObjectProtocol};
use objc2_quartz_core::{CADisplayLink, CATransaction};
use rustc_hash::FxHashMap;

use crate::{animation::UiAnimation, mount::Mounter, text::CoreTextEngine, view::NshView};

/// What the engine thread sends the main thread.
enum Message {
    /// A batch, and when the engine handed it over (while a performance
    /// monitor measures).
    Batch(MountBatch, Option<Instant>),
    /// The engine finished handling events up to this count.
    Handled(u64),
    Error(String),
    Frame,
    HotUpdateFailed,
    /// The engine laid the app out at this size ([`MountSink::resized`]).
    Resized(Size<Points>),
    /// The app imports chunk `id` (`import()` of a split bundle), which its
    /// bundle does not hold ([`MountSink::load_chunk`]).
    LoadChunk(String),
    /// A function the app runs on the main thread
    /// ([`MountSink::run_on_main_thread`]), after the batches before it.
    Run(MainThreadTask),
}

/// How long the main thread waits for the layout at a new window size
/// (a frame at 60 Hz): see the module doc.
const RESIZE_WAIT: std::time::Duration = std::time::Duration::from_millis(16);

/// How long after a deadline the timer that keeps it fires
/// ([`Surface::keep_deadline`]): more than a frame, so while the window
/// shows the display link's frame always comes first.
const LATE: f64 = 0.05;

/// How long a test's app waits for the link's frame before one runs
/// without it ([`Surface::keep_deadline`]): a frame at 60 Hz.
const TEST_FRAME: f64 = 1.0 / 60.0;

/// The main-thread time one frame spends applying queued batches
/// ([`Surface::apply_queued`]): about half a refresh at 120 Hz, which
/// leaves the rest to input, animations and Core Animation's commit.
const FRAME_BATCHES: std::time::Duration = std::time::Duration::from_millis(4);

thread_local! {
    /// The surfaces of this (main) thread, by key: the sink wakes one by
    /// its key, as dispatched closures must be `Send`.
    static SURFACES: RefCell<FxHashMap<u64, Weak<Surface>>> = RefCell::default();
}

static NEXT_KEY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// The surface with `key`, if it still exists.
fn find(key: u64) -> Option<Rc<Surface>> {
    SURFACES.with(|s| s.borrow().get(&key).and_then(Weak::upgrade))
}

/// Forwards batches from the engine thread to the main thread.
struct Sink {
    key: u64,
    tx: Sender<Message>,
    /// A wake-up is on its way: no need for another.
    pending: Arc<AtomicBool>,
    /// A performance monitor measures: batches carry when they were sent.
    perf: Arc<AtomicBool>,
    /// The directory `import()` chunks load from ([`AppOptions::chunks`]).
    chunks: Option<PathBuf>,
    wake: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Sink {
    fn send(&self, message: Message) {
        let _ = self.tx.send(message);
        if !self.pending.swap(true, Ordering::AcqRel) {
            let key = self.key;
            DispatchQueue::main().exec_async(move || {
                if let Some(surface) = find(key) {
                    surface.drain();
                }
            });
            if let Some(wake) = &self.wake {
                wake();
            }
        }
    }
}

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let sent = self.perf.load(Ordering::Relaxed).then(Instant::now);
        self.send(Message::Batch(batch, sent));
    }

    fn handled(&self, events: u64) {
        self.send(Message::Handled(events));
    }

    fn report_error(&self, message: &str) {
        self.send(Message::Error(message.to_owned()));
    }

    fn request_frame(&self) {
        self.send(Message::Frame);
    }

    fn hot_update_failed(&self) {
        self.send(Message::HotUpdateFailed);
    }

    fn run_on_main_thread(&self, task: MainThreadTask) {
        self.send(Message::Run(task));
    }

    fn resized(&self, size: Size<Points>) {
        self.send(Message::Resized(size));
    }

    fn load_chunk(&self, id: &str) -> bool {
        if self.chunks.is_none() {
            return false;
        }
        self.send(Message::LoadChunk(id.to_owned()));
        true
    }
}

define_class!(
    /// The display link's target: ticks the surface with its key.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = u64]
    #[name = "NshTicker"]
    struct Ticker;

    unsafe impl NSObjectProtocol for Ticker {}

    impl Ticker {
        #[unsafe(method(tick:))]
        fn tick(&self, link: &CADisplayLink) {
            match find(*self.ivars()) {
                Some(surface) => surface.ticked(link),
                None => link.invalidate(),
            }
        }
    }
);

/// The surface's display link and the root view it was made from: the
/// root of the window it follows ([`crate::window::link_root`]), the
/// surface's own for the main window.
struct DisplayLink {
    link: Retained<CADisplayLink>,
    root: NshView,
}

/// Called when the app reports a fatal error (development hosts show it).
pub(crate) type ErrorHandler = Box<dyn Fn(&str)>;

/// Turns the performance monitor on or off.
type PerfToggle = Box<dyn Fn(bool)>;

/// One engine and its views.
pub(crate) struct Surface {
    key: u64,
    pub(crate) mtm: MainThreadMarker,
    /// The root view (node [`ROOT_ID`]): the surface's view.
    pub(crate) root: NshView,
    /// Views by node id, and what mounting needs between items.
    pub(crate) mounter: RefCell<Mounter>,
    /// The native animation graph.
    pub(crate) anim: RefCell<UiAnimation>,
    /// Stacks, screens and modals.
    pub(crate) nav: RefCell<crate::navigation::Nav>,
    /// The app's own windows (`Window.open`), by the dialog root each
    /// shows ([`crate::window`]).
    pub(crate) windows: RefCell<rustc_hash::FxHashMap<NodeId, crate::window::AppWindow>>,
    /// Pointer input state ([`crate::input`]).
    pub(crate) input: crate::input::Input,
    /// The text selection ([`crate::text::Selected`]).
    pub(crate) selection: crate::text::Selected,
    engine: RefCell<Option<Engine>>,
    pub(crate) capture_revision: Cell<u64>,
    pub(crate) focus_generation: Cell<u64>,
    events_handled: Cell<u64>,
    pub(crate) terminal: Cell<bool>,
    pub(crate) terminal_scale: Cell<f32>,
    pub(crate) terminal_clipboard: RefCell<TerminalClipboard>,
    pub(crate) terminal_quit: Cell<bool>,
    pub(crate) terminal_wake: RefCell<Option<Arc<dyn Fn() + Send + Sync>>>,
    control: RefCell<Option<EngineControl>>,
    rx: RefCell<Option<Receiver<Message>>>,
    pending: RefCell<Arc<AtomicBool>>,
    /// The environment the engine was last told about.
    pub(crate) environment: Cell<Environment>,
    /// The app's appearance (`nsh.json`, `setColorScheme`): the color
    /// scheme is the system's resolved with it ([`crate::system`]).
    pub(crate) appearance: Cell<nsh_core::platform::Appearance>,
    /// The directory `import()` chunks load from ([`crate::AppOptions::chunks`]).
    pub(crate) chunks: RefCell<Option<PathBuf>>,
    /// The embedding app's locale and text size, standing in for the
    /// system's ([`crate::AppView::set_locale`], `set_font_scale`).
    pub(crate) host_environment: Cell<nsh_core::platform::HostEnvironment>,
    /// The embedding app's theme overrides
    /// ([`crate::AppView::set_theme_overrides`]): sent to every engine the
    /// surface starts, before its first frame.
    pub(crate) host_tokens: RefCell<Option<nsh_engine::Tokens>>,
    /// Links that came before the engine started (the one that launched
    /// the app): sent before the app's code runs, so its first
    /// `UrlScheme.url()` reads them.
    pub(crate) launch_links: RefCell<Vec<String>>,
    /// JS asked for a display frame.
    js_frame: Cell<bool>,
    /// Batches that arrived while animations run, and what came after
    /// them, applied at the start of the next frames
    /// ([`Surface::apply_queued`]).
    queued: RefCell<VecDeque<Message>>,
    /// Frame callbacks of the platform's own animations (scroll glides,
    /// transitions), called on every frame until they are done, each with
    /// its deadline ([`Next::At`]; a new one's is when it was added).
    frame_callbacks: RefCell<Vec<(FrameCallback, Option<f64>)>>,
    /// How many of the frame callbacks have only cosmetic work left (a
    /// scroll indicator fading out, keyframes repeating forever): what
    /// [`Surface::animating`] does not count.
    #[cfg(feature = "dev")]
    cosmetic_frames: Cell<usize>,
    /// The model of a test session's app (`nsh test --target`).
    #[cfg(feature = "dev")]
    test_model: RefCell<Option<std::sync::Arc<nsh_testing::agent::Model>>>,
    /// The display link, once something wanted frames, and the root it
    /// was made from (it is made again from another window's:
    /// [`Surface::follow_windows`]).
    link: RefCell<Option<DisplayLink>>,
    /// The rate the display link was last asked for
    /// ([`Surface::frame_rate`]; `None`: the screen's highest).
    link_rate: Cell<Option<f32>>,
    /// The highest refresh rate of the screen the display link was last
    /// asked on ([`Surface::frame_rate_range`]), in Hz; `0` before any.
    link_screen_max: Cell<f32>,
    /// The frame callbacks that asked for a rate in the last frame
    /// ([`Surface::cap_frame`]): how many, and the highest rate.
    capped_frames: Cell<(usize, f32)>,
    /// The performance monitor ([`Surface::set_perf_monitor`]), and whether
    /// there is one (for the sink, on the engine thread).
    perf: RefCell<Option<Arc<PerfMonitor>>>,
    perf_on: Arc<AtomicBool>,
    /// Shows or hides the view's performance monitor
    /// (`setFpsEnabled`): set by its [`crate::AppView`],
    /// which owns the panel.
    pub(crate) perf_toggle: RefCell<Option<PerfToggle>>,
    /// When the last frame ran (`CACurrentMediaTime`).
    last_tick: Cell<f64>,
    /// The deadline the timer scheduled waits for
    /// ([`Surface::keep_deadline`]).
    keeper: Cell<Option<f64>>,
    /// The engine missed the deadline of a resize ([`RESIZE_WAIT`]): later
    /// resizes do not wait until it reports one done.
    resize_late: Cell<bool>,
    /// The move count ([`crate::sight::moves`]) the last revisit started
    /// at: frames revisit only when it moved ([`Surface::tick`]).
    revisited: Cell<u64>,
    /// Views resized since the last pass ([`Surface::draw_when_shown`]).
    resized: RefCell<Vec<NshView>>,
    /// The background set under the root ([`crate::system`]).
    pub(crate) background: Cell<Option<nsh_core::Color>>,
    /// The surface fills the standalone runner's window ([`crate::run_app`]),
    /// not a view of a host app.
    pub(crate) standalone: Cell<bool>,
    /// An embedded AppView opts out of painting a surface background
    /// ([`crate::AppOptions::transparent`]). Standalone windows instead
    /// track their live transparency in `main_window`.
    pub(crate) transparent: Cell<bool>,
    on_error: RefCell<Option<ErrorHandler>>,
    on_hot_update_failed: RefCell<Option<Box<dyn Fn()>>>,
    /// Where `asset:/` image URIs resolve ([`crate::image::set_asset_base`]).
    pub(crate) asset_base: RefCell<Option<crate::image::AssetBase>>,
    /// The reader of `asset:/` image URIs bound to the running load, over
    /// [`Self::asset_base`] ([`crate::AppView::load_with_config`]).
    pub(crate) image_assets: RefCell<crate::image::AssetSource>,
    /// The engine's sounds and players ([`crate::audio`]).
    pub(crate) audio: crate::audio::Speaker,
    /// The disk cache of downloaded images ([`crate::image::set_disk_cache`]).
    pub(crate) image_cache: RefCell<Option<nsh_core::image::DiskCache>>,
    /// The roots the app's `<Image>` files are read under
    /// ([`nsh_engine::Engine::media_files`]).
    pub(crate) media_files: RefCell<Arc<nsh_core::access::MediaFiles>>,
    /// The window's chrome: title bar, menus ([`crate::chrome`]).
    pub(crate) chrome: crate::chrome::Chrome,
    /// What is held of the main window: its policies, title bar and look
    /// ([`crate::window`]).
    pub(crate) main_window: crate::window::Held,
    /// The window observed for its bounds ([`crate::window_state`]).
    pub(crate) window: crate::window_state::Watch,
    /// The mode the standalone app's main window opens in, until it first
    /// shows (hidden at launch: nsh.json `window.defaultVisible: false`)
    /// ([`crate::window::launched_main`]).
    pub(crate) main_open_mode: Cell<Option<nsh_core::desktop::WindowMode>>,
    /// Videos, web views and registered native components.
    pub(crate) native: crate::native::NativeState,
    /// The app's keyboard shortcuts ([`crate::keymap`]).
    pub(crate) keymap: crate::keymap::KeymapState,
    pub(crate) file_drop: crate::file_drop::State,
    /// The GPU device and the shader views rendering ([`crate::shader`]).
    pub(crate) shaders: crate::shader::Shaders,
}

/// A per-frame callback ([`Surface::add_frame_callback`]): gets the frame
/// time in seconds, returns what it has left.
pub(crate) type FrameCallback = Box<dyn FnMut(&Rc<Surface>, f64) -> Next>;

/// What a frame callback has left after a frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Next {
    /// Nothing: it is not called again.
    Done,
    /// Drawing only (a shader, a scroll indicator's fade): the next frame,
    /// when there is one.
    Frame,
    /// Something that changes the app's state ends at this time (seconds,
    /// the frames' clock: a view detached, an event sent): it is called by
    /// then even while no frames are drawn ([`Surface::keep_deadline`]),
    /// and on every frame until then.
    At(f64),
}

impl From<bool> for Next {
    /// Whether it wants the next frame, for drawing only.
    fn from(more: bool) -> Self {
        if more { Next::Frame } else { Next::Done }
    }
}

#[derive(Default)]
pub(crate) struct TerminalClipboard {
    pub(crate) text: Option<String>,
    pub(crate) pending: Option<String>,
}

impl Surface {
    /// A surface with no app yet.
    pub(crate) fn new(mtm: MainThreadMarker, environment: Environment) -> Rc<Surface> {
        let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
        let root = NshView::new(mtm, ROOT_ID, nsh_core::ViewKind::View);
        let surface = Rc::new(Surface {
            key,
            mtm,
            root: root.clone(),
            mounter: RefCell::new(Mounter::new(root.clone())),
            anim: RefCell::new(UiAnimation::default()),
            nav: RefCell::default(),
            windows: RefCell::default(),
            input: Default::default(),
            selection: Default::default(),
            engine: RefCell::new(None),
            capture_revision: Cell::new(0),
            focus_generation: Cell::new(0),
            events_handled: Cell::new(0),
            terminal: Cell::new(false),
            terminal_scale: Cell::new(1.0),
            terminal_clipboard: RefCell::default(),
            terminal_quit: Cell::new(false),
            terminal_wake: RefCell::new(None),
            control: RefCell::new(None),
            rx: RefCell::new(None),
            pending: RefCell::new(Arc::new(AtomicBool::new(false))),
            environment: Cell::new(environment),
            appearance: Cell::default(),
            chunks: RefCell::new(None),
            host_environment: Cell::default(),
            host_tokens: RefCell::new(None),
            launch_links: RefCell::new(Vec::new()),
            js_frame: Cell::new(false),
            queued: RefCell::default(),
            frame_callbacks: RefCell::default(),
            #[cfg(feature = "dev")]
            cosmetic_frames: Cell::new(0),
            #[cfg(feature = "dev")]
            test_model: RefCell::default(),
            link: RefCell::new(None),
            link_rate: Cell::new(None),
            link_screen_max: Cell::new(0.0),
            capped_frames: Cell::new((0, 0.0)),
            perf: RefCell::new(None),
            perf_on: Arc::new(AtomicBool::new(false)),
            perf_toggle: RefCell::new(None),
            last_tick: Cell::new(0.0),
            keeper: Cell::new(None),
            resize_late: Cell::new(false),
            revisited: Cell::new(0),
            resized: RefCell::default(),
            background: Cell::new(None),
            standalone: Cell::new(false),
            transparent: Cell::new(false),
            on_error: RefCell::new(None),
            on_hot_update_failed: RefCell::new(None),
            asset_base: RefCell::new(None),
            image_assets: RefCell::default(),
            audio: Default::default(),
            image_cache: RefCell::new(None),
            media_files: RefCell::default(),
            native: Default::default(),
            keymap: Default::default(),
            file_drop: Default::default(),
            chrome: Default::default(),
            main_window: Default::default(),
            window: Default::default(),
            main_open_mode: Cell::new(None),
            shaders: Default::default(),
        });
        SURFACES.with(|s| s.borrow_mut().insert(key, Rc::downgrade(&surface)));
        // CoreText's first use loads fonts and caches (tens of
        // milliseconds): done off the main thread before the first text.
        static PREWARM: std::sync::Once = std::sync::Once::new();
        PREWARM.call_once(|| {
            std::thread::spawn(crate::text::prewarm);
        });
        root.set_surface(Rc::downgrade(&surface));
        surface
    }

    /// The surface's key ([`Surface::with_key`]).
    pub(crate) fn key(&self) -> u64 {
        self.key
    }

    /// The surface with `key`, for callbacks that must be `Send`.
    pub(crate) fn with_key(key: u64) -> Option<Rc<Surface>> {
        find(key)
    }

    /// Starts `config`'s app, replacing what ran.
    pub(crate) fn start(self: &Rc<Self>, mut config: EngineConfig) {
        self.stop();
        let env = self.environment.get();
        config.viewport = Size::new(env.window.width, env.window.height);
        config.environment = env;
        // A test session's app: the test's storage, network and trace.
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.test_model.borrow() {
            model.set_up_engine(&mut config);
        }
        let (tx, rx) = crossbeam_channel::unbounded();
        let pending = Arc::new(AtomicBool::new(false));
        let sink = Sink {
            key: self.key,
            tx,
            pending: pending.clone(),
            perf: self.perf_on.clone(),
            chunks: self.chunks.borrow().clone(),
            wake: self.terminal_wake.borrow().clone(),
        };
        *self.rx.borrow_mut() = Some(rx);
        *self.pending.borrow_mut() = pending;
        // The embedding app's theme overrides are in the first frame.
        let tokens = self.host_tokens.borrow().clone();
        // The displays are there as the app first renders.
        let displays = crate::window_state::displays(self.mtm);
        let links = std::mem::take(&mut *self.launch_links.borrow_mut());
        let setup = |control: &EngineControl| {
            if tokens.is_some() {
                control.set_tokens(tokens);
            }
            control.set_displays(displays);
            for url in links {
                control.dispatch_event(
                    nsh_core::ROOT_ID,
                    nsh_core::EventKind::UrlScheme,
                    nsh_core::EventPayload::Map(vec![(
                        nsh_core::url_scheme::URL,
                        nsh_core::PayloadValue::Str(url),
                    )]),
                );
            }
        };
        // Remote images download with NSURLSession.
        crate::image::install_transport();
        match Engine::start_with(config, CoreTextEngine::default, sink, setup) {
            Ok(engine) => {
                // The app's downloaded images go through its disk cache.
                crate::image::set_disk_cache(self, engine.image_cache());
                *self.media_files.borrow_mut() = engine.media_files();
                // The test moves its clock through the engine.
                #[cfg(feature = "dev")]
                if let Some(model) = &*self.test_model.borrow() {
                    model.engine_started(engine.control());
                }
                if let Some(monitor) = &*self.perf.borrow() {
                    engine.control().set_perf_monitor(Some(monitor.clone()));
                }
                *self.control.borrow_mut() = Some(engine.control());
                *self.engine.borrow_mut() = Some(engine);
            }
            Err(err) => {
                let error = format!("cannot start the engine: {err}");
                log::error!("{error}");
                if let Some(handler) = &*self.on_error.borrow() {
                    handler(&error);
                }
            }
        }
    }

    /// Stops the app and removes its views.
    pub(crate) fn stop(&self) {
        // Dropping the engine joins its thread.
        self.control.borrow_mut().take();
        self.engine.borrow_mut().take();
        self.rx.borrow_mut().take();
        self.events_handled.set(0);
        crate::text_input::stopped(self);
        self.mounter.borrow_mut().clear();
        self.native.clear();
        crate::system::clear(self);
        *self.anim.borrow_mut() = UiAnimation::default();
        self.nav.borrow_mut().reset();
        crate::window::close_all(self);
        crate::input::reset(self);
        crate::keymap::clear(self);
        crate::tray::release(self.key);
        crate::global_shortcut::release(self.key);
        self.js_frame.set(false);
        self.queued.borrow_mut().clear();
        self.resize_late.set(false);
        self.frame_callbacks.borrow_mut().clear();
        #[cfg(feature = "dev")]
        self.cosmetic_frames.set(0);
        crate::shader::clear(self);
    }

    #[cfg(feature = "terminal")]
    pub(crate) fn running(&self) -> bool {
        self.control.borrow().is_some()
    }

    pub(crate) fn events_sent(&self) -> u64 {
        self.control
            .borrow()
            .as_ref()
            .map_or(0, EngineControl::events_sent)
    }

    pub(crate) fn events_handled(&self) -> u64 {
        self.events_handled.get()
    }

    /// Calls `f` with the engine's control, if an app runs.
    pub(crate) fn control(&self, f: impl FnOnce(&EngineControl)) {
        if let Some(control) = &*self.control.borrow() {
            f(control);
        }
    }

    /// Sends an event to JS.
    pub(crate) fn event(&self, id: NodeId, kind: EventKind, payload: EventPayload) {
        self.control(|c| {
            c.set_focus_path(crate::input::focus_path(self));
            c.dispatch_event(id, kind, payload);
        });
    }

    /// Shows fatal app errors with `f` (development and terminal hosts).
    #[cfg(any(feature = "dev", feature = "terminal"))]
    pub(crate) fn set_error_handler(&self, f: ErrorHandler) {
        *self.on_error.borrow_mut() = Some(f);
    }

    /// Runs `f` when a hot update could not be applied in place.
    #[cfg(feature = "dev")]
    pub(crate) fn set_hot_update_failed(&self, f: impl Fn() + 'static) {
        *self.on_hot_update_failed.borrow_mut() = Some(Box::new(f));
    }

    /// Updates the environment and tells the engine.
    pub(crate) fn set_environment(&self, mut environment: Environment) {
        // The embedding app's settings over the system's.
        self.host_environment.get().apply(&mut environment);
        if self.environment.replace(environment) != environment {
            self.control(|c| c.set_environment(environment));
            crate::system::environment_applied(self);
        }
    }

    /// The root view got a new size (the window's content area): the
    /// layout at that size is applied before this returns, unless the
    /// engine takes longer than [`RESIZE_WAIT`] (see the module doc).
    pub(crate) fn resized(self: &Rc<Self>, width: f32, height: f32) {
        {
            let mut s = self.root.state_mut();
            if s.frame.size.width.0 == width && s.frame.size.height.0 == height {
                return;
            }
            s.frame.size.width.0 = width;
            s.frame.size.height.0 = height;
        }
        let mut env = self.environment.get();
        env.window = nsh_core::Size::new(nsh_core::Points(width), nsh_core::Points(height));
        self.environment.set(env);
        self.control(|c| {
            c.resize(Size::new(Points(width), Points(height)));
            c.set_environment(env);
        });
        crate::navigation::surface_resized(self, width, height);
        // Full screen and the window's size change the title bar's area.
        crate::chrome::update_area(self);
        self.await_layout(Size::new(Points(width), Points(height)));
    }

    /// Waits for the engine's layout at `size` and applies what it sent
    /// meanwhile ([`Surface::resized`]).
    fn await_layout(self: &Rc<Self>, size: Size<Points>) {
        if self.resize_late.get() || self.mounter.try_borrow_mut().is_err() {
            return;
        }
        let Some(rx) = self.rx.borrow().clone() else {
            return;
        };
        if self.control.borrow().is_none() {
            return;
        }
        let deadline = Instant::now() + RESIZE_WAIT;
        let monitor = self.perf.borrow().clone();
        let mut applied = false;
        // Measured as main-thread work: the wait is part of the frame.
        self.measure(true, || {
            quiet(|| {
                // What waited for a frame comes before the new layout.
                let queued = std::mem::take(&mut *self.queued.borrow_mut());
                for message in queued {
                    applied |= self.handle(message, monitor.as_deref());
                }
                loop {
                    let Ok(message) = rx.recv_deadline(deadline) else {
                        self.resize_late.set(true);
                        break;
                    };
                    let done = matches!(message, Message::Resized(s) if s == size);
                    applied |= self.handle(message, monitor.as_deref());
                    if done {
                        break;
                    }
                }
                if applied {
                    self.write_animations();
                    self.revisit();
                }
            })
        });
        if applied {
            self.ensure_ticking();
        }
    }

    /// Measures this surface's frames and commits into `monitor` from now
    /// on (`None`: stops). While one measures, the display link runs on
    /// every refresh (it closes the frames).
    pub(crate) fn set_perf_monitor(self: &Rc<Self>, monitor: Option<Arc<PerfMonitor>>) {
        self.perf_on.store(monitor.is_some(), Ordering::Relaxed);
        self.control(|c| c.set_perf_monitor(monitor.clone()));
        *self.perf.borrow_mut() = monitor;
        self.ensure_ticking();
    }

    /// Runs `f`, main-thread work on the surface, and adds its time to the
    /// current frame of the performance monitor, if one measures; `dirty`:
    /// it changes what the screen shows.
    pub(crate) fn measure<R>(&self, dirty: bool, f: impl FnOnce() -> R) -> R {
        let Some(monitor) = self.perf.borrow().clone() else {
            return f();
        };
        let start = Instant::now();
        let r = f();
        monitor.record_work(start.elapsed(), dirty);
        r
    }

    /// Handles what the engine sent. While animations run (see the module
    /// doc), batches wait for the next frame ([`Surface::apply_queued`]).
    pub(crate) fn drain(self: &Rc<Self>) {
        let monitor = self.perf.borrow().clone();
        let start = monitor.as_ref().map(|_| Instant::now());
        self.pending.borrow().store(false, Ordering::Release);
        let messages: Vec<Message> = match &*self.rx.borrow() {
            Some(rx) => rx.try_iter().collect(),
            None => return,
        };
        let mut applied = false;
        quiet(|| {
            for message in messages {
                // A batch waits while the platform's own animations run;
                // whatever follows a waiting batch waits behind it, which
                // keeps the order (a frame request only sets a flag).
                let wait = match message {
                    Message::Batch(..) => self.defers_batches(),
                    Message::Frame => false,
                    _ => !self.queued.borrow().is_empty(),
                };
                if wait {
                    self.queued.borrow_mut().push_back(message);
                    continue;
                }
                applied |= self.handle(message, monitor.as_deref());
            }
            if applied {
                self.write_animations();
                self.revisit();
            }
        });
        if let (Some(monitor), Some(start)) = (monitor, start) {
            // Core Animation's commit (drawing what changed) included.
            let cost = start.elapsed();
            monitor.record_work(cost, applied);
            if applied {
                crate::fps::drained(cost);
            }
        }
        self.ensure_ticking();
    }

    /// Handles one message from the engine; returns whether it was a
    /// batch (applied).
    fn handle(self: &Rc<Self>, message: Message, monitor: Option<&PerfMonitor>) -> bool {
        match message {
            Message::Batch(batch, sent) => {
                if let (Some(monitor), Some(sent)) = (monitor, sent) {
                    monitor.record_latency(sent.elapsed());
                }
                self.apply(&batch);
                return true;
            }
            Message::Handled(events) => {
                self.events_handled.set(events);
                crate::text_input::engine_caught_up(self);
            }
            Message::Error(message) => {
                log::error!("{message}");
                #[cfg(feature = "dev")]
                if let Some(model) = &*self.test_model.borrow() {
                    model.error(message.to_string());
                }
                if let Some(f) = &*self.on_error.borrow() {
                    f(&message);
                }
            }
            Message::Frame => self.js_frame.set(true),
            Message::HotUpdateFailed => {
                if let Some(f) = &*self.on_hot_update_failed.borrow() {
                    f();
                }
            }
            Message::Resized(_) => self.resize_late.set(false),
            Message::Run(task) => task.run(),
            Message::LoadChunk(id) => {
                // The chunk's file name is its id: `is_chunk_name`
                // (nsh-js) restricted it to a plain `<stem>.js`, so this
                // join cannot leave the directory. Chunks load as source:
                // they are files, and files can be replaced — bytecode
                // only comes from trusted resources (`Bundle::read`).
                let dir = self.chunks.borrow().clone();
                // Keep the reply tied to this engine if the app is replaced
                // while the file is being read. File I/O stays off AppKit's
                // main thread, as it does for images.
                let Some(control) = self.control.borrow().clone() else {
                    return false;
                };
                DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
                    DispatchQueueGlobalPriority::Default,
                ))
                .exec_async(move || {
                    match dir
                        .map(|dir| std::fs::read_to_string(dir.join(&id)))
                        .transpose()
                    {
                        Ok(Some(code)) => control.chunk_loaded(Chunk::source(id, code)),
                        Ok(None) => {
                            log::error!("chunk {id}: no chunk directory");
                            control.chunk_failed(id, "no chunk directory".to_owned());
                        }
                        Err(err) => {
                            log::error!("chunk {id}: {err}");
                            control.chunk_failed(id, err.to_string());
                        }
                    }
                });
            }
        }
        false
    }

    fn apply(self: &Rc<Self>, batch: &MountBatch) {
        self.capture_revision
            .set(self.capture_revision.get().wrapping_add(1));
        // A batch may change what a running frame callback has left (a
        // transition retargeted, a scroll view told to scroll) without
        // adding one: their deadlines are of before it, so each runs again
        // by now, without frames too, and tells its new one.
        let now = objc2_quartz_core::CACurrentMediaTime();
        for (_, at) in self.frame_callbacks.borrow_mut().iter_mut() {
            *at = Some(now);
        }
        crate::access::prepare(batch);
        self.mounter.borrow_mut().begin_batch(&batch.items);
        for item in &batch.items {
            self.anim.borrow_mut().apply(item);
            if !matches!(
                item,
                MountItem::Animation(_) | MountItem::AnimationBindings { .. }
            ) {
                self.mounter.borrow_mut().apply(self, item);
            }
        }
        self.mounter.borrow_mut().end_batch(self);
        crate::access::batch_applied();
        crate::window::batch_applied(self);
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.test_model.borrow() {
            model.apply(batch);
        }
    }

    /// Writes the animated values to the views and reports finished
    /// animations.
    pub(crate) fn write_animations(&self) {
        let (finished, moved) = {
            let mut anim = self.anim.borrow_mut();
            anim.write(&self.mounter.borrow());
            let mut moved = Vec::new();
            anim.write_components(
                |id| crate::native::has_component(self, id),
                |id, name, value| moved.push((id, std::sync::Arc::<str>::from(name), value)),
            );
            (std::mem::take(&mut anim.finished), moved)
        };
        // Shaders whose animated uniforms moved render from the next frame.
        crate::shader::wake(self);
        // No surface state borrowed while the app's components run.
        crate::native::component_animated(self, moved);
        crate::scroll::pin_animated_sticky(self);
        if !finished.is_empty() {
            self.control(|c| c.animations_finished(finished));
        }
    }

    /// Calls `f` on every display frame until it is done ([`Next`]); the
    /// first time by now even while no frames are drawn.
    pub(crate) fn add_frame_callback(
        self: &Rc<Self>,
        f: impl FnMut(&Rc<Surface>, f64) -> Next + 'static,
    ) {
        let now = objc2_quartz_core::CACurrentMediaTime();
        self.frame_callbacks
            .borrow_mut()
            .push((Box::new(f), Some(now)));
        self.ensure_ticking();
    }

    /// Calls `f` on every display frame while it returns true, for what
    /// only draws (a shader, a selection's autoscroll): nothing it does
    /// comes due without frames ([`Next::Frame`]).
    pub(crate) fn add_draw_callback(
        self: &Rc<Self>,
        mut f: impl FnMut(&Rc<Surface>, f64) -> bool + 'static,
    ) {
        self.add_frame_callback(move |surface, now| f(surface, now).into());
    }

    /// A frame callback's work left became cosmetic (`on`: a scroll
    /// indicator fading out, which shows nothing the app did; keyframes
    /// repeating forever, a spinner, which never end) or no longer is; it
    /// ends with `on` false.
    pub(crate) fn cosmetic_frame(&self, on: bool) {
        #[cfg(feature = "dev")]
        {
            let n = self.cosmetic_frames.get();
            self.cosmetic_frames
                .set(if on { n + 1 } else { n.saturating_sub(1) });
        }
        #[cfg(not(feature = "dev"))]
        let _ = on;
    }

    /// Whether a native animation runs: the graph's (not one looping
    /// forever, which no test step waits for), the platform's own (scroll
    /// glides, zooms; not a scroll indicator's fade, after which nothing
    /// changes) or a view's transitions (not its keyframes repeating
    /// forever); or batches wait for the next frame.
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.anim.borrow().finishing()
            || self.frame_callbacks.borrow().len() > self.cosmetic_frames.get()
            || !self.queued.borrow().is_empty()
    }

    /// Keeps the model `nsh test --target` steps see of the app
    /// ([`nsh_testing::agent::Model`]): every batch applied and every error
    /// go to it from now on.
    #[cfg(feature = "dev")]
    pub(crate) fn set_test_model(&self, model: Option<std::sync::Arc<nsh_testing::agent::Model>>) {
        *self.test_model.borrow_mut() = model;
    }

    /// Whether batches wait for the start of the next frame: while native
    /// animations or the platform's own (scroll glides, zooms) run, so
    /// their frames are not delayed by batches landing between them, and
    /// behind batches already waiting. A frame JS asked for alone does not
    /// make them wait: what it draws shows in the frame it was asked for.
    fn defers_batches(&self) -> bool {
        !self.queued.borrow().is_empty()
            || self.anim.borrow().animating()
            || !self.frame_callbacks.borrow().is_empty()
    }

    /// Whether the display link should run (animations, frame callbacks,
    /// a JS frame request): while it does, a bounds commit mid-scroll
    /// lands on a live frame.
    pub(crate) fn wants_frames(&self) -> bool {
        self.js_frame.get()
            || !self.queued.borrow().is_empty()
            || self.anim.borrow().animating()
            || !self.frame_callbacks.borrow().is_empty()
    }

    /// Runs the display link while animations run or JS wants a frame (or
    /// a performance monitor measures), made from the root of a window
    /// that shows ([`crate::window::link_root`]): the window it followed
    /// may have hidden, closed or been covered since it last ran, and its
    /// link would not fire.
    pub(crate) fn ensure_ticking(self: &Rc<Self>) {
        if !self.wants_frames() {
            if self.perf.borrow().is_none() {
                return;
            }
        } else {
            self.keep_deadline();
        }
        let root = {
            let link = self.link.borrow();
            crate::window::link_root(self, link.as_ref().map(|l| &l.root))
        };
        if let Some(link) = &*self.link.borrow()
            && link.root == root
        {
            if link.link.isPaused() {
                // The window may have moved to another screen meanwhile.
                self.capped_frames.set((0, 0.0));
                self.link_rate.set(self.frame_rate());
                link.link
                    .setPreferredFrameRateRange(self.frame_rate_range(&link.root));
                link.link.setPaused(false);
            } else {
                // What starts now may want more frames than what runs;
                // only a full frame lowers the rate (`ticked`).
                self.update_frame_rate(link, true);
            }
            return;
        }
        self.make_link(root);
    }

    /// Makes the display link from `root`, the root view of the window it
    /// follows ([`crate::window::link_root`]), in place of the one there
    /// was: it runs, at the rate what wants frames needs on that window's
    /// screen.
    fn make_link(&self, root: NshView) {
        if let Some(old) = self.link.borrow_mut().take() {
            old.link.invalidate();
        }
        let ticker = Ticker::alloc(self.mtm).set_ivars(self.key);
        // SAFETY: NSObject's initializer.
        let ticker: Retained<Ticker> = unsafe { msg_send![super(ticker), init] };
        // SAFETY: `tick:` takes the display link, as the selector requires;
        // the link retains its target.
        let link = unsafe {
            root.ns()
                .displayLinkWithTarget_selector(&ticker, sel!(tick:))
        };
        self.capped_frames.set((0, 0.0));
        self.link_rate.set(self.frame_rate());
        link.setPreferredFrameRateRange(self.frame_rate_range(&root));
        // SAFETY: the main run loop exists while the app runs.
        unsafe {
            link.addToRunLoop_forMode(
                &objc2_foundation::NSRunLoop::mainRunLoop(),
                objc2_foundation::NSRunLoopCommonModes,
            )
        };
        *self.link.borrow_mut() = Some(DisplayLink { link, root });
    }

    /// A window of the surface showed, hid, closed, was minimized, covered
    /// or uncovered, or moved to another screen: the display link moves to
    /// the window it should follow ([`crate::window::link_root`]), as the
    /// one it followed may give no frames now (the app's own window the
    /// user scrolls, while the main window hides). A running link is made
    /// again from that window's root; a paused one goes, and
    /// [`Surface::ensure_ticking`] makes the next there.
    pub(crate) fn follow_windows(&self) {
        let (root, running) = {
            let Ok(link) = self.link.try_borrow() else {
                return;
            };
            let Some(link) = link.as_ref() else {
                return;
            };
            let root = crate::window::link_root(self, Some(&link.root));
            if root == link.root {
                return;
            }
            (root, !link.link.isPaused())
        };
        if running {
            self.make_link(root);
        } else if let Some(old) = self.link.borrow_mut().take() {
            old.link.invalidate();
        }
    }

    /// A frame callback that keeps running needs at most `hz` frames per
    /// second (a keyframe animation alone on its view): it says so on each
    /// of its frames.
    pub(crate) fn cap_frame(&self, hz: f32) {
        let (count, highest) = self.capped_frames.get();
        self.capped_frames.set((count + 1, highest.max(hz)));
    }

    /// The highest frame rate what wants frames needs, in Hz: the graph's
    /// animations ([`nsh_core::animation::Graph::frame_rate`]) and the
    /// frame callbacks that asked for a rate. `None`, the screen's
    /// highest, as soon as one runs uncapped or anything else wants frames:
    /// a JS frame request, batches waiting, a frame callback without a rate
    /// (transitions, scroll glides, gestures).
    fn frame_rate(&self) -> Option<f32> {
        if self.js_frame.get() || !self.queued.borrow().is_empty() {
            return None;
        }
        let (capped, highest) = self.capped_frames.get();
        if self.frame_callbacks.borrow().len() > capped {
            return None;
        }
        let callbacks = (capped > 0).then_some(highest);
        let anim = self.anim.borrow();
        if !anim.animating() {
            return callbacks;
        }
        let graph = anim.frame_rate();
        match callbacks {
            Some(_) => nsh_core::animation::highest_frame_rate(graph, callbacks),
            None => graph,
        }
    }

    /// Asks the display link for the rate what runs needs, when it changed
    /// (`raise_only`: when it is higher).
    fn update_frame_rate(&self, link: &DisplayLink, raise_only: bool) {
        let rate = self.frame_rate();
        let old = self.link_rate.get();
        let changed = match (old, rate) {
            (Some(old), Some(new)) => new > old || (!raise_only && new < old),
            (Some(_), None) => true,
            (None, Some(_)) => !raise_only,
            (None, None) => false,
        };
        if changed {
            self.link_rate.set(rate);
            link.link
                .setPreferredFrameRateRange(self.frame_rate_range(&link.root));
        }
    }

    /// The frame rates the display link asks for ([`frame_rate_range`]) at
    /// the rate it was last asked for, on the screen of `root`'s window
    /// (the window the link follows).
    fn frame_rate_range(&self, root: &NshView) -> objc2_quartz_core::CAFrameRateRange {
        let max = self.screen_max(root);
        self.link_screen_max.set(max);
        frame_rate_range(self.link_rate.get(), max)
    }

    /// The highest refresh rate of the screen `root`'s window is on (the
    /// main screen while it is in no window), in Hz.
    fn screen_max(&self, root: &NshView) -> f32 {
        root.ns()
            .window()
            .and_then(|w| w.screen())
            .or_else(|| objc2_app_kit::NSScreen::mainScreen(self.mtm))
            .map_or(60, |s| s.maximumFramesPerSecond())
            .max(1) as f32
    }

    /// Asks the display link for its rates again when the screen of the
    /// window it follows refreshes at another rate than the one they were
    /// made for: the window moved to another screen, or the screen's mode
    /// changed. The link follows the window's screen, but its rates stay
    /// what they were asked for: one resumed on a 60 Hz screen and kept
    /// running (a looping animation, the performance monitor) stays at
    /// 60 Hz on a 120 Hz one.
    fn follow_screen(&self, link: &DisplayLink) {
        if self.screen_max(&link.root) != self.link_screen_max.get() {
            link.link
                .setPreferredFrameRateRange(self.frame_rate_range(&link.root));
        }
    }

    /// When the next thing that changes the app's state comes due without
    /// a frame: an animation of the graph or a frame callback ending, a
    /// batch waiting for a frame (`now`). `None` when only drawing is
    /// left: an animation looping forever, a JS frame request.
    fn deadline(&self, now: f64) -> Option<f64> {
        let queued = (!self.queued.borrow().is_empty()).then_some(now);
        let callbacks = self
            .frame_callbacks
            .borrow()
            .iter()
            .filter_map(|(_, at)| *at)
            .reduce(f64::min);
        [self.anim.borrow().deadline(now), callbacks, queued]
            .into_iter()
            .flatten()
            .reduce(f64::min)
    }

    /// Makes what comes due happen on time while no frames are drawn: the
    /// display link does not fire while none of the surface's windows
    /// shows (hidden, minimized or covered) or the screen is locked, and
    /// animations must still end (a transition detaches its views when it
    /// does, a modal reports its dismissal, an animation its end to JS). A
    /// timer waits for the next deadline ([`Surface::deadline`]) and a
    /// little more ([`LATE`]); if no frame ran since it came due, it runs
    /// one, which steps everything to its time, ends what ended and gives
    /// the next deadline. While a window shows, frames always come first
    /// and the timer does nothing: frames are the display link's only.
    /// Nothing is scheduled for what only draws (a spinner, a JS frame
    /// request), so a hidden window with an endless animation does no
    /// work.
    fn keep_deadline(self: &Rc<Self>) {
        let now = objc2_quartz_core::CACurrentMediaTime();
        // A test's app runs as on screen whatever covers its window (the
        // test windows do not come to the front): what wants a frame gets
        // one a frame later when the link gives none, drawing too (a JS
        // frame request, a list binding its rows over frames).
        let testing = self.testing() && self.wants_frames();
        let deadline = if testing {
            Some(now)
        } else {
            self.deadline(now)
        };
        let Some(at) = deadline else {
            return;
        };
        // One timer at a time: the one waiting for an earlier deadline
        // schedules the next when it fires.
        if self.keeper.get().is_some_and(|pending| pending <= at) {
            return;
        }
        self.keeper.set(Some(at));
        let key = self.key;
        let late = if testing { TEST_FRAME } else { LATE };
        let ms = ((at + late - now).max(0.0) * 1000.0).ceil() as u64;
        after(ms, move || {
            let Some(surface) = find(key) else { return };
            // An earlier deadline took its place and schedules on.
            if surface.keeper.get() != Some(at) {
                return;
            }
            surface.keeper.set(None);
            if surface.last_tick.get() < at {
                let now = objc2_quartz_core::CACurrentMediaTime();
                let period = now - surface.last_tick.get();
                surface.frame(now, period);
            }
            surface.keep_deadline();
        });
    }

    /// Whether `nsh test --target` drives the app ([`Surface::set_test_model`]).
    pub(crate) fn testing(&self) -> bool {
        #[cfg(feature = "dev")]
        return self.test_model.borrow().is_some();
        #[cfg(not(feature = "dev"))]
        false
    }

    fn ticked(self: &Rc<Self>, link: &CADisplayLink) {
        // A link another took the place of (made from another window's
        // root) gives no more frames: one clock at a time.
        let ours = self
            .link
            .borrow()
            .as_ref()
            .is_some_and(|l| std::ptr::eq(&*l.link, link));
        if !ours {
            link.invalidate();
            return;
        }
        let now = link.timestamp();
        self.frame(now, link.targetTimestamp() - link.timestamp());
        // The frame may have made the link again, from another window.
        let current = self.link.borrow();
        let Some(current) = current.as_ref() else {
            return;
        };
        if !self.wants_frames() && self.perf.borrow().is_none() {
            current.link.setPaused(true);
        } else {
            self.follow_screen(current);
            self.update_frame_rate(current, false);
        }
    }

    /// One display frame at `now`, `period` seconds after the previous one
    /// (the display link's, or one a deadline ran without a frame).
    pub(crate) fn frame(self: &Rc<Self>, now: f64, period: f64) {
        self.capture_revision
            .set(self.capture_revision.get().wrapping_add(1));
        self.last_tick.set(objc2_quartz_core::CACurrentMediaTime());
        let Some(monitor) = self.perf.borrow().clone() else {
            return quiet(|| self.tick(now));
        };
        let start = Instant::now();
        let dirty = self.wants_frames();
        quiet(|| self.tick(now));
        let cost = start.elapsed();
        monitor.record_work(cost, dirty);
        crate::fps::ticked(cost);
        monitor.vsync(
            Instant::now(),
            std::time::Duration::from_secs_f64(period.max(0.0)),
        );
    }

    fn tick(self: &Rc<Self>, now: f64) {
        let applied = self.apply_queued(FRAME_BATCHES);
        if self.anim.borrow().animating() {
            self.anim.borrow_mut().tick(now);
            self.write_animations();
        }
        let callbacks = std::mem::take(&mut *self.frame_callbacks.borrow_mut());
        // The callbacks kept say again which rate they need.
        self.capped_frames.set((0, 0.0));
        let mut kept: Vec<(FrameCallback, Option<f64>)> = callbacks
            .into_iter()
            .filter_map(|(mut f, _)| match f(self, now) {
                Next::Done => None,
                Next::Frame => Some((f, None)),
                Next::At(at) => Some((f, Some(at))),
            })
            .collect();
        {
            let mut added = self.frame_callbacks.borrow_mut();
            kept.append(&mut added);
            *added = kept;
        }
        if self.js_frame.replace(false) {
            self.control(|c| c.frame());
        }
        // A batch changes more than moves count (clips, deletions); else
        // only a move can show a view put off. A transform counts only
        // when its subtree has deferred drawing or placement, so an
        // endless animation elsewhere does not force a pass every frame.
        if applied || crate::sight::moves() != self.revisited.get() {
            self.revisit();
        }
    }

    /// Applies the batches that waited for this frame, in order, until
    /// `budget` is spent (at least one): the rest wait for the next frame,
    /// so one frame's main-thread work stays bounded when the engine sent
    /// several. A batch is the state of one commit and is applied whole.
    /// Whether any was.
    fn apply_queued(self: &Rc<Self>, budget: std::time::Duration) -> bool {
        if self.queued.borrow().is_empty() {
            return false;
        }
        let monitor = self.perf.borrow().clone();
        let start = Instant::now();
        let mut applied = false;
        while !applied
            || start.elapsed() < budget
            || matches!(self.queued.borrow().front(), Some(Message::Handled(_)))
        {
            let Some(message) = self.queued.borrow_mut().pop_front() else {
                break;
            };
            applied |= self.handle(message, monitor.as_deref());
        }
        if applied {
            self.write_animations();
        }
        applied
    }

    /// `view`, already marked stale, is drawn at the next pass if it can be
    /// seen. It may be placed while a batch holds the mounter, which is why
    /// it waits here.
    pub(crate) fn draw_when_shown(&self, view: NshView) {
        self.resized.borrow_mut().push(view);
    }

    /// The window's live resize starts or ends.
    pub(crate) fn live_resize(&self, on: bool) {
        if let Ok(mut mounter) = self.mounter.try_borrow_mut() {
            mounter.set_live_resize(on);
        }
        if !on {
            self.revisit();
        }
    }

    /// Draws views whose drawing changed out of sight and that show now
    /// ([`Mounter::draw_when_shown`]); after anything that moves views.
    pub(crate) fn revisit(&self) {
        // Taken before the pass: a move during it is revisited next frame.
        let moves = crate::sight::moves();
        if let Ok(mounter) = self.mounter.try_borrow() {
            mounter.place_shown();
        }
        if let Ok(mounter) = self.mounter.try_borrow()
            && mounter.adopt_stale(&mut self.resized.borrow_mut())
            && mounter.revisit()
        {
            self.revisited.set(moves);
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        let key = self.key;
        if let Some(link) = self.link.borrow_mut().take() {
            link.link.invalidate();
        }
        crate::text_input::disposed(key);
        crate::tray::release(key);
        crate::global_shortcut::release(key);
        let _ = SURFACES.try_with(|s| s.borrow_mut().remove(&key));
    }
}

/// The frame rates a display link asks for to run at `rate` Hz (`None`:
/// the screen's highest) on a screen of `max` Hz: `rate` within the
/// screen's as the preferred and the highest, and at least 80 Hz below
/// it on a faster screen (else the link may settle on 60) or the rate
/// itself on a slower one, so a request of 30 Hz is honored.
fn frame_rate_range(rate: Option<f32>, max: f32) -> objc2_quartz_core::CAFrameRateRange {
    let max = max.max(1.0);
    let preferred = rate.map_or(max, |rate| rate.clamp(1.0, max));
    objc2_quartz_core::CAFrameRateRange {
        minimum: preferred.min(80.0),
        maximum: preferred,
        preferred,
    }
}

/// Runs `f` on the main queue after `ms` milliseconds.
pub(crate) fn after(ms: u64, f: impl FnOnce() + Send + 'static) {
    let when = dispatch2::DispatchTime::NOW.time((ms * 1_000_000) as i64);
    if let Err(err) = DispatchQueue::main().after(when, f) {
        log::error!("cannot schedule a frame: {err:?}");
    }
}

/// Runs `f` with Core Animation's implicit animations off: layers change
/// at once, as the core said (animations are explicit).
pub(crate) fn quiet<R>(f: impl FnOnce() -> R) -> R {
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    let r = f();
    CATransaction::commit();
    r
}

#[cfg(test)]
mod tests {
    use super::frame_rate_range;

    fn range(rate: Option<f32>, max: f32) -> [f32; 3] {
        let r = frame_rate_range(rate, max);
        [r.minimum, r.maximum, r.preferred]
    }

    #[test]
    fn frame_rate_ranges_ask_for_the_rate_within_the_screens() {
        // Nothing asked for: the screen's highest, at least 80 Hz.
        assert_eq!(range(None, 120.0), [80.0, 120.0, 120.0]);
        assert_eq!(range(None, 60.0), [60.0, 60.0, 60.0]);
        // A rate below the screen's: that rate, not forced up to 80.
        assert_eq!(range(Some(30.0), 120.0), [30.0, 30.0, 30.0]);
        assert_eq!(range(Some(100.0), 120.0), [80.0, 100.0, 100.0]);
        // Above the screen's: the screen's.
        assert_eq!(range(Some(240.0), 120.0), [80.0, 120.0, 120.0]);
        assert_eq!(range(Some(90.0), 60.0), [60.0, 60.0, 60.0]);
        // Every range is one the display link takes.
        for rate in [None, Some(0.5), Some(24.0), Some(48.0), Some(144.0)] {
            for max in [0.0, 30.0, 60.0, 120.0, 144.0] {
                let [minimum, maximum, preferred] = range(rate, max);
                assert!(0.0 < minimum && minimum <= preferred && preferred <= maximum);
            }
        }
    }
}
