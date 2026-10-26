//! One surface: an engine thread and the views it mounts on the main
//! thread.
//!
//! The engine thread hands each commit to [`Sink`], which queues it and
//! wakes the main thread once (`DispatchQueue::main`); the main thread
//! drains the queue and applies every batch in order ([`Surface::drain`]).
//! Native animations and JS frame requests run on the root view's display
//! link while there is something to do. While native animations or the
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
    Chunk, Engine, EngineConfig, EngineControl, Environment, MountSink, perf::PerfMonitor,
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
    Error(String),
    Frame,
    HotUpdateFailed,
    /// The engine laid the app out at this size ([`MountSink::resized`]).
    Resized(Size<Points>),
    /// The app imports chunk `id` (`import()` of a split bundle), which its
    /// bundle does not hold ([`MountSink::load_chunk`]).
    LoadChunk(String),
}

/// How long the main thread waits for the layout at a new window size
/// (a frame at 60 Hz): see the module doc.
const RESIZE_WAIT: std::time::Duration = std::time::Duration::from_millis(16);

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
        }
    }
}

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let sent = self.perf.load(Ordering::Relaxed).then(Instant::now);
        self.send(Message::Batch(batch, sent));
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

/// Called when the app reports a fatal error (development hosts show it).
pub(crate) type ErrorHandler = Box<dyn Fn(&str)>;

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
    /// Pointer input state ([`crate::input`]).
    pub(crate) input: crate::input::Input,
    /// The text selection ([`crate::text::Selected`]).
    pub(crate) selection: crate::text::Selected,
    engine: RefCell<Option<Engine>>,
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
    /// JS asked for a display frame.
    js_frame: Cell<bool>,
    /// Batches that arrived while animations run, and what came after
    /// them, applied at the start of the next frames
    /// ([`Surface::apply_queued`]).
    queued: RefCell<VecDeque<Message>>,
    /// Frame callbacks of the platform's own animations (scroll glides,
    /// transitions): called on every frame while they return true.
    frame_callbacks: RefCell<Vec<FrameCallback>>,
    /// The model of a test session's app (`nsh test --target`).
    #[cfg(feature = "dev")]
    test_model: RefCell<Option<std::sync::Arc<nsh_testing::agent::Model>>>,
    /// The display link, while it runs.
    link: RefCell<Option<Retained<CADisplayLink>>>,
    /// The performance monitor ([`Surface::set_perf_monitor`]), and whether
    /// there is one (for the sink, on the engine thread).
    perf: RefCell<Option<Arc<PerfMonitor>>>,
    perf_on: Arc<AtomicBool>,
    /// When the last frame ran (`CACurrentMediaTime`), and whether the
    /// fallback timer is scheduled ([`Surface::watch_link`]).
    last_tick: Cell<f64>,
    fallback: Cell<bool>,
    /// The engine missed the deadline of a resize ([`RESIZE_WAIT`]): later
    /// resizes do not wait until it reports one done.
    resize_late: Cell<bool>,
    /// The background set under the root ([`crate::system`]).
    pub(crate) background: Cell<Option<nsh_core::Color>>,
    on_error: RefCell<Option<ErrorHandler>>,
    on_hot_update_failed: RefCell<Option<Box<dyn Fn()>>>,
    /// Where `asset:/` image URIs resolve ([`crate::image::set_asset_base`]).
    pub(crate) asset_base: RefCell<Option<crate::image::AssetBase>>,
    /// The disk cache of downloaded images ([`crate::image::set_disk_cache`]).
    pub(crate) image_cache: RefCell<Option<nsh_core::image::DiskCache>>,
    /// The window's chrome: title bar, menus ([`crate::chrome`]).
    pub(crate) chrome: crate::chrome::Chrome,
    /// Videos, web views and registered native components.
    pub(crate) native: crate::native::NativeState,
    /// The app's keyboard shortcuts ([`crate::keymap`]).
    pub(crate) keymap: crate::keymap::KeymapState,
    pub(crate) file_drop: crate::file_drop::State,
}

/// A per-frame callback ([`Surface::add_frame_callback`]): gets the frame
/// time in seconds, returns whether it wants the next frame.
pub(crate) type FrameCallback = Box<dyn FnMut(&Rc<Surface>, f64) -> bool>;

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
            input: Default::default(),
            selection: Default::default(),
            engine: RefCell::new(None),
            control: RefCell::new(None),
            rx: RefCell::new(None),
            pending: RefCell::new(Arc::new(AtomicBool::new(false))),
            environment: Cell::new(environment),
            appearance: Cell::default(),
            chunks: RefCell::new(None),
            host_environment: Cell::default(),
            host_tokens: RefCell::new(None),
            js_frame: Cell::new(false),
            queued: RefCell::default(),
            frame_callbacks: RefCell::default(),
            #[cfg(feature = "dev")]
            test_model: RefCell::default(),
            link: RefCell::new(None),
            perf: RefCell::new(None),
            perf_on: Arc::new(AtomicBool::new(false)),
            last_tick: Cell::new(0.0),
            fallback: Cell::new(false),
            resize_late: Cell::new(false),
            background: Cell::new(None),
            on_error: RefCell::new(None),
            on_hot_update_failed: RefCell::new(None),
            asset_base: RefCell::new(None),
            image_cache: RefCell::new(None),
            native: Default::default(),
            keymap: Default::default(),
            file_drop: Default::default(),
            chrome: Default::default(),
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
        };
        *self.rx.borrow_mut() = Some(rx);
        *self.pending.borrow_mut() = pending;
        // The embedding app's theme overrides are in the first frame.
        let tokens = self.host_tokens.borrow().clone();
        let setup = |control: &EngineControl| {
            if tokens.is_some() {
                control.set_tokens(tokens);
            }
        };
        match Engine::start_with(config, CoreTextEngine::default, sink, setup) {
            Ok(engine) => {
                // The app's downloaded images go through its disk cache.
                crate::image::set_disk_cache(self, engine.image_cache());
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
            Err(err) => log::error!("cannot start the engine: {err}"),
        }
    }

    /// Stops the app and removes its views.
    pub(crate) fn stop(&self) {
        // Dropping the engine joins its thread.
        self.control.borrow_mut().take();
        self.engine.borrow_mut().take();
        self.rx.borrow_mut().take();
        self.mounter.borrow_mut().clear();
        self.native.clear();
        crate::system::clear(self);
        *self.anim.borrow_mut() = UiAnimation::default();
        self.nav.borrow_mut().reset();
        crate::input::reset(self);
        crate::keymap::clear(self);
        self.js_frame.set(false);
        self.queued.borrow_mut().clear();
        self.resize_late.set(false);
        self.frame_callbacks.borrow_mut().clear();
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

    /// Shows fatal app errors with `f` (development hosts).
    #[cfg(feature = "dev")]
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
        crate::system::surface_resized(self, width, height);
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
    fn drain(self: &Rc<Self>) {
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
        crate::access::prepare(batch);
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
        // No surface state borrowed while the app's components run.
        crate::native::component_animated(self, moved);
        crate::scroll::pin_animated_sticky(self);
        if !finished.is_empty() {
            self.control(|c| c.animations_finished(finished));
        }
    }

    /// Calls `f` on every display frame while it returns true.
    pub(crate) fn add_frame_callback(
        self: &Rc<Self>,
        f: impl FnMut(&Rc<Surface>, f64) -> bool + 'static,
    ) {
        self.frame_callbacks.borrow_mut().push(Box::new(f));
        self.ensure_ticking();
    }

    /// Whether a native animation runs: the graph's, or the platform's own
    /// (scroll glides, zooms); or batches wait for the next frame.
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.anim.borrow().animating()
            || !self.frame_callbacks.borrow().is_empty()
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
    /// a performance monitor measures).
    pub(crate) fn ensure_ticking(self: &Rc<Self>) {
        if !self.wants_frames() {
            if self.perf.borrow().is_none() {
                return;
            }
        } else {
            self.watch_link();
        }
        if let Some(link) = &*self.link.borrow() {
            if link.isPaused() {
                // The window may have moved to another screen meanwhile.
                link.setPreferredFrameRateRange(self.frame_rate_range());
                link.setPaused(false);
            }
            return;
        }
        let ticker = Ticker::alloc(self.mtm).set_ivars(self.key);
        // SAFETY: NSObject's initializer.
        let ticker: Retained<Ticker> = unsafe { msg_send![super(ticker), init] };
        // SAFETY: `tick:` takes the display link, as the selector requires;
        // the link retains its target.
        let link = unsafe {
            self.root
                .ns()
                .displayLinkWithTarget_selector(&ticker, sel!(tick:))
        };
        link.setPreferredFrameRateRange(self.frame_rate_range());
        // SAFETY: the main run loop exists while the app runs.
        unsafe {
            link.addToRunLoop_forMode(
                &objc2_foundation::NSRunLoop::mainRunLoop(),
                objc2_foundation::NSRunLoopCommonModes,
            )
        };
        *self.link.borrow_mut() = Some(link);
    }

    /// The frame rates the display link asks for: the screen's highest
    /// (120 Hz on ProMotion), at least 80 there. Without it the link may
    /// settle on 60 Hz.
    fn frame_rate_range(&self) -> objc2_quartz_core::CAFrameRateRange {
        let max = self
            .root
            .ns()
            .window()
            .and_then(|w| w.screen())
            .or_else(|| objc2_app_kit::NSScreen::mainScreen(self.mtm))
            .map_or(60, |s| s.maximumFramesPerSecond())
            .max(1) as f32;
        objc2_quartz_core::CAFrameRateRange {
            minimum: max.min(80.0),
            maximum: max,
            preferred: max,
        }
    }

    /// Keeps frames coming when the display link stops: it does not fire
    /// while the window is occluded or minimized, or the screen is locked,
    /// and animations must still end (a transition detaches its views when
    /// it does, a modal reports its dismissal). While frames are wanted and
    /// the link has not ticked for 100 ms, a 60 Hz main-queue timer ticks
    /// instead.
    fn watch_link(self: &Rc<Self>) {
        if self.fallback.replace(true) {
            return;
        }
        fn check(key: u64) {
            let Some(surface) = find(key) else { return };
            if !surface.wants_frames() {
                surface.fallback.set(false);
                return;
            }
            let now = objc2_quartz_core::CACurrentMediaTime();
            let stalled = now - surface.last_tick.get() > 0.1;
            if stalled {
                surface.last_tick.set(now);
                surface.frame(now, 1.0 / 60.0);
            }
            let delay = if stalled { 16 } else { 100 };
            after(delay, move || check(key));
        }
        let key = self.key;
        after(100, move || check(key));
    }

    fn ticked(self: &Rc<Self>, link: &CADisplayLink) {
        let now = link.timestamp();
        self.last_tick.set(objc2_quartz_core::CACurrentMediaTime());
        self.frame(now, link.targetTimestamp() - link.timestamp());
        if !self.wants_frames() && self.perf.borrow().is_none() {
            link.setPaused(true);
        }
    }

    /// One display frame at `now`, `period` seconds after the previous one
    /// (the display link's, or the fallback timer's).
    fn frame(self: &Rc<Self>, now: f64, period: f64) {
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
        self.apply_queued(FRAME_BATCHES);
        if self.anim.borrow().animating() {
            self.anim.borrow_mut().tick(now);
            self.write_animations();
        }
        let callbacks = std::mem::take(&mut *self.frame_callbacks.borrow_mut());
        let mut kept: Vec<FrameCallback> = callbacks
            .into_iter()
            .filter_map(|mut f| f(self, now).then_some(f))
            .collect();
        {
            let mut added = self.frame_callbacks.borrow_mut();
            kept.append(&mut added);
            *added = kept;
        }
        if self.js_frame.replace(false) {
            self.control(|c| c.frame());
        }
        self.revisit();
    }

    /// Applies the batches that waited for this frame, in order, until
    /// `budget` is spent (at least one): the rest wait for the next frame,
    /// so one frame's main-thread work stays bounded when the engine sent
    /// several. A batch is the state of one commit and is applied whole.
    fn apply_queued(self: &Rc<Self>, budget: std::time::Duration) {
        if self.queued.borrow().is_empty() {
            return;
        }
        let monitor = self.perf.borrow().clone();
        let start = Instant::now();
        let mut applied = false;
        while !applied || start.elapsed() < budget {
            let Some(message) = self.queued.borrow_mut().pop_front() else {
                break;
            };
            applied |= self.handle(message, monitor.as_deref());
        }
        if applied {
            self.write_animations();
        }
    }

    /// Draws views whose drawing changed out of sight and that show now
    /// ([`Mounter::draw_when_shown`]); after anything that moves views.
    pub(crate) fn revisit(&self) {
        if let Ok(mounter) = self.mounter.try_borrow() {
            mounter.revisit();
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        let key = self.key;
        if let Some(link) = self.link.borrow_mut().take() {
            link.invalidate();
        }
        let _ = SURFACES.try_with(|s| s.borrow_mut().remove(&key));
    }
}

/// Runs `f` on the main queue after `ms` milliseconds.
fn after(ms: u64, f: impl FnOnce() + Send + 'static) {
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
