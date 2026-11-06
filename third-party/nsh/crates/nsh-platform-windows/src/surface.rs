//! One surface: an engine thread and the views it mounts on the window's
//! (main) thread.
//!
//! The engine thread hands each commit to [`Sink`], which queues it and
//! posts one wake-up message to the window ([`crate::window::WM_NSH_WAKE`]);
//! the main thread drains the queue and applies every batch in order
//! ([`Surface::drain`]). Native animations and JS frame requests run on the
//! window's frame ticker ([`crate::window::Ticker`], paced by the
//! compositor) while there is something to do. Drawing is coalesced:
//! changes invalidate the window and `WM_PAINT` draws the tree once
//! ([`crate::render::frame`]).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{EventKind, EventPayload, MountBatch, MountItem, NodeId, Points, ROOT_ID, Size};
use nsh_engine::{Engine, EngineConfig, EngineControl, Environment, MountSink};
use rustc_hash::FxHashMap;
use windows::Win32::Foundation::{HWND, RECT};

use crate::{
    animation::UiAnimation,
    mount::Mounter,
    text::DWriteTextEngine,
    view::{Hosted, NshView},
};

/// What the engine thread sends the main thread.
enum Message {
    Batch(MountBatch),
    Error(String),
    Frame,
    HotUpdateFailed,
    /// The engine laid the app out at this size ([`MountSink::resized`]).
    Resized(Size<Points>),
    Handled(u64),
}

/// How long the main thread waits for the layout at a new window size
/// (a frame at 60 Hz): see [`Surface::resized`].
const RESIZE_WAIT: std::time::Duration = std::time::Duration::from_millis(16);

thread_local! {
    /// The surfaces of this (main) thread, by key.
    static SURFACES: RefCell<FxHashMap<u64, Weak<Surface>>> = RefCell::default();
}

static NEXT_KEY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Forwards batches from the engine thread to the main thread.
struct Sink {
    /// The window to wake (an `HWND` as an integer: window handles may be
    /// used from any thread, `PostMessage` is thread-safe).
    hwnd: Arc<std::sync::atomic::AtomicIsize>,
    tx: Sender<Message>,
    /// A wake-up is on its way: no need for another.
    pending: Arc<AtomicBool>,
    wake: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Sink {
    fn send(&self, message: Message) {
        let _ = self.tx.send(message);
        if !self.pending.swap(true, Ordering::AcqRel) {
            crate::window::wake(self.hwnd.load(Ordering::Acquire));
            if let Some(wake) = &self.wake {
                wake();
            }
        }
    }
}

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        self.send(Message::Batch(batch));
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

    fn handled(&self, events: u64) {
        self.send(Message::Handled(events));
    }
}

/// Called on every frame with the frame's time until it returns false
/// ([`Surface::on_frame`]).
pub(crate) type FrameClient = Box<dyn FnMut(&Rc<Surface>, f64) -> bool>;

/// Called with the new size (points) when the surface is resized.
pub(crate) type ResizeHandler = Box<dyn Fn(f32, f32)>;

/// A window shortcut: true if it took the key (down).
pub(crate) type ShortcutHandler = Box<dyn Fn(&crate::input::KeyEvent) -> bool>;

/// Called when the app reports a fatal error (development hosts show it).
pub(crate) type ErrorHandler = Box<dyn Fn(&str)>;

/// Receives top-level window activation on the UI thread.
pub(crate) type ActivationHandler = Box<dyn Fn(bool) + Send>;

/// One engine and its views.
pub(crate) struct Surface {
    pub(crate) terminal_active: Cell<Option<bool>>,
    pub(crate) terminal_focus_generation: Cell<u64>,
    pub(crate) terminal_wake: RefCell<Option<Arc<dyn Fn() + Send + Sync>>>,
    key: u64,
    /// The root view (node [`ROOT_ID`]): fills the window.
    pub(crate) root: NshView,
    /// Views by node id, and what mounting needs between items.
    pub(crate) mounter: RefCell<Mounter>,
    /// The views by node id (the mounter's, readable while it applies a
    /// batch).
    views: Rc<crate::mount::Views>,
    /// The native animation graph.
    pub(crate) anim: RefCell<UiAnimation>,
    /// Stacks, screens and modals.
    pub(crate) nav: RefCell<crate::navigation::Nav>,
    /// Pointer input state ([`crate::input`]).
    pub(crate) input: crate::input::Input,
    /// Native file-drop destinations.
    pub(crate) file_drop: crate::file_drop::State,
    engine: RefCell<Option<Engine>>,
    control: RefCell<Option<EngineControl>>,
    rx: RefCell<Option<Receiver<Message>>>,
    pending: RefCell<Arc<AtomicBool>>,
    /// The window drawn into (shared with the engine's sink).
    hwnd: Arc<std::sync::atomic::AtomicIsize>,
    /// Pixels per point.
    scale: Cell<f32>,
    /// Size of the window's client area in pixels.
    pixels: Cell<(u32, u32)>,
    /// The window's swap chain ([`crate::render::frame`]).
    pub(crate) swap: RefCell<Option<crate::gfx::SwapChain>>,
    /// The scale the swap chain's target bitmap was made for.
    pub(crate) target_scale: Cell<f32>,
    /// A paint is requested.
    invalid: Cell<bool>,
    /// The next frame draws the whole window ([`Surface::invalidate`]).
    full_damage: Cell<bool>,
    /// The change stamp of the last request to draw the whole window
    /// ([`Surface::whole_change`]).
    whole_change: Cell<u64>,
    /// Views that changed since the last frame
    /// ([`Surface::invalidate_view`]).
    dirty: RefCell<Vec<NshView>>,
    /// The environment the engine was last told about.
    pub(crate) environment: Cell<Environment>,
    /// The app's appearance (`nsh.json`, `setColorScheme`): the color
    /// scheme is the system's resolved with it ([`crate::system`]).
    pub(crate) appearance: Cell<nsh_core::platform::Appearance>,
    /// The embedding app's locale and text size, standing in for the
    /// system's ([`crate::AppView::set_locale`], `set_font_scale`).
    pub(crate) host_environment: Cell<nsh_core::platform::HostEnvironment>,
    /// The embedding app's theme overrides
    /// ([`crate::AppView::set_theme_overrides`]): sent to every engine the
    /// surface starts, before its first frame.
    pub(crate) host_tokens: RefCell<Option<nsh_engine::Tokens>>,
    /// JS asked for a display frame.
    js_frame: Cell<bool>,
    /// The performance monitor, while it measures ([`crate::fps`]).
    fps: RefCell<Option<Rc<crate::fps::Fps>>>,
    /// Paces animation frames while something animates.
    ticker: RefCell<Option<crate::window::Ticker>>,
    /// Extra frame clients (transitions, glides, spinners): called on every
    /// frame until they return false ([`Surface::on_frame`]).
    frame_clients: RefCell<Vec<FrameClient>>,
    /// The model of a test session's app (`nsh test --target windows`).
    #[cfg(feature = "dev")]
    test_model: RefCell<Option<std::sync::Arc<nsh_testing::agent::Model>>>,
    /// The time of the current frame (seconds since the surface was made).
    now: Cell<f64>,
    epoch: std::time::Instant,
    on_error: RefCell<Option<ErrorHandler>>,
    on_hot_update_failed: RefCell<Option<Box<dyn Fn()>>>,
    /// The GPU device shader views render with, opened when the first
    /// shader is mounted (`None` inside: there is none).
    shader_renderer: std::cell::OnceCell<Option<Rc<nsh_engine::shader::Renderer>>>,
    /// The views whose shader reads what is behind them (`sample_backdrop`),
    /// or did ([`crate::shader::backdrop_areas`] leaves those out).
    pub(crate) backdrop_readers: RefCell<Vec<NodeId>>,
    /// Where `asset:/` image URIs resolve ([`crate::image::set_asset_base`]).
    pub(crate) asset_base: RefCell<Option<crate::image::AssetBase>>,
    pub(crate) min_size: Cell<Option<(i32, i32)>>,
    pub(crate) on_activation: RefCell<Option<ActivationHandler>>,
    active: Cell<bool>,
    pub(crate) image_assets: RefCell<Option<nsh_core::image::loader::ReadAsset>>,
    /// The disk cache of downloaded images ([`crate::image::set_disk_cache`]).
    pub(crate) image_cache: RefCell<Option<nsh_core::image::DiskCache>>,
    /// Videos, web views and registered native components.
    pub(crate) native: crate::native::NativeState,
    /// The app's keyboard shortcuts ([`crate::keymap`]).
    pub(crate) keymap: crate::keymap::KeymapState,
    /// Hosted items drawn by the last frame ([`Hosted::placed`]).
    placed: RefCell<Vec<(Rc<dyn Hosted>, RECT)>>,
    /// The window's composition while it has web views (each holds it).
    composition: RefCell<Weak<crate::compose::Composition>>,
    /// Composed items (web views) drawn by the last frame.
    composed: RefCell<Vec<Rc<dyn Hosted>>>,
    /// The window's chrome: title bar, menus ([`crate::chrome`]).
    pub(crate) chrome: crate::chrome::Chrome,
    /// Called after the surface is resized (development overlays).
    pub(crate) on_resized: RefCell<Vec<ResizeHandler>>,
    /// The engine missed the deadline of a resize ([`RESIZE_WAIT`]): later
    /// resizes do not wait until it reports one done.
    resize_late: Cell<bool>,
    /// Keys the window takes before anything focused sees them (the
    /// standalone app's full screen, the dev host's reload).
    pub(crate) shortcuts: RefCell<Vec<ShortcutHandler>>,
    events_handled: Cell<u64>,
}

impl Surface {
    /// A surface with no app and no window yet.
    pub(crate) fn new(environment: Environment) -> Rc<Surface> {
        let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
        let root = NshView::new(ROOT_ID, nsh_core::ViewKind::View);
        let mounter = Mounter::new(root.clone());
        let surface = Rc::new(Surface {
            terminal_active: Cell::new(None),
            terminal_focus_generation: Cell::new(0),
            terminal_wake: RefCell::new(None),
            key,
            root: root.clone(),
            views: mounter.views.clone(),
            mounter: RefCell::new(mounter),
            anim: RefCell::new(UiAnimation::default()),
            nav: RefCell::default(),
            input: Default::default(),
            file_drop: Default::default(),
            engine: RefCell::new(None),
            control: RefCell::new(None),
            rx: RefCell::new(None),
            pending: RefCell::new(Arc::new(AtomicBool::new(false))),
            hwnd: Arc::new(std::sync::atomic::AtomicIsize::new(0)),
            scale: Cell::new(1.0),
            pixels: Cell::new((0, 0)),
            swap: RefCell::new(None),
            fps: RefCell::new(None),
            target_scale: Cell::new(0.0),
            invalid: Cell::new(false),
            // The first frame draws everything.
            full_damage: Cell::new(true),
            whole_change: Cell::new(0),
            dirty: RefCell::default(),
            environment: Cell::new(environment),
            appearance: Cell::default(),
            host_environment: Cell::default(),
            host_tokens: RefCell::new(None),
            js_frame: Cell::new(false),
            ticker: RefCell::new(None),
            frame_clients: RefCell::default(),
            #[cfg(feature = "dev")]
            test_model: RefCell::default(),
            now: Cell::new(0.0),
            epoch: std::time::Instant::now(),
            on_error: RefCell::new(None),
            on_hot_update_failed: RefCell::new(None),
            shader_renderer: std::cell::OnceCell::new(),
            backdrop_readers: RefCell::default(),
            asset_base: RefCell::new(None),
            image_assets: RefCell::new(None),
            min_size: Cell::new(None),
            on_activation: RefCell::new(None),
            active: Cell::new(false),
            image_cache: RefCell::new(None),
            native: Default::default(),
            keymap: Default::default(),
            placed: RefCell::default(),
            composition: RefCell::default(),
            composed: RefCell::default(),
            on_resized: RefCell::default(),
            resize_late: Cell::new(false),
            shortcuts: RefCell::default(),
            events_handled: Cell::new(0),
            chrome: Default::default(),
        });
        SURFACES.with(|s| s.borrow_mut().insert(key, Rc::downgrade(&surface)));
        let weak = Rc::downgrade(&surface);
        root.set_invalidate(Rc::new(move |view| {
            if let Some(surface) = weak.upgrade() {
                surface.invalidate_view(view);
            }
        }));
        surface
    }

    /// The GPU device shader views render with ([`crate::shader`]), opened
    /// the first time one asks.
    pub(crate) fn shader_renderer(&self) -> Option<Rc<nsh_engine::shader::Renderer>> {
        self.shader_renderer
            .get_or_init(|| {
                nsh_engine::shader::Renderer::new(nsh_engine::shader::PixelFormat::Bgra)
                    .map(Rc::new)
            })
            .clone()
    }

    /// Settles [`Surface::shader_renderer`] as opened without a device, as
    /// on a machine with none (tests open no GPU device).
    #[cfg(test)]
    pub(crate) fn without_shader_renderer(&self) {
        let _ = self.shader_renderer.set(None);
    }

    /// The surface with `key`, if it is alive.
    pub(crate) fn by_key(key: u64) -> Option<Rc<Surface>> {
        SURFACES.with(|s| s.borrow().get(&key).and_then(Weak::upgrade))
    }

    pub(crate) fn activation_changed(&self, active: bool) {
        if !active {
            crate::input::cancel_keyboard_press(self);
        }
        if self.active.replace(active) != active
            && let Some(handler) = &*self.on_activation.borrow()
        {
            handler(active);
        }
    }

    /// Its key ([`Surface::by_key`]).
    pub(crate) fn key(&self) -> u64 {
        self.key
    }

    /// The window it draws into (invalid before it has one).
    pub(crate) fn hwnd(&self) -> HWND {
        HWND(self.hwnd.load(Ordering::Acquire) as *mut _)
    }

    /// Attaches the surface to its window.
    pub(crate) fn set_hwnd(&self, hwnd: HWND) {
        self.hwnd.store(hwnd.0 as isize, Ordering::Release);
        *self.swap.borrow_mut() = None;
    }

    /// Pixels per point.
    pub(crate) fn scale(&self) -> f32 {
        self.scale.get()
    }

    /// The client area in pixels.
    pub(crate) fn pixel_size(&self) -> (u32, u32) {
        self.pixels.get()
    }

    /// The surface's size in points.
    pub(crate) fn size(&self) -> (f32, f32) {
        let s = self.root.state();
        (s.frame.size.width.0, s.frame.size.height.0)
    }

    /// The current frame's time (seconds, the animation clock).
    pub(crate) fn now(&self) -> f64 {
        self.now.get()
    }

    /// Seconds since the surface was made (the animation clock).
    pub(crate) fn clock(&self) -> f64 {
        self.epoch.elapsed().as_secs_f64()
    }

    /// Measures the surface's frames and commits from now on; one
    /// `nsh::perf` line a second ([`crate::fps`]). The ticker then runs on
    /// every refresh.
    pub(crate) fn enable_fps(self: &Rc<Self>) {
        if self.fps.borrow().is_some() {
            return;
        }
        let fps = Rc::new(crate::fps::Fps::new());
        self.control(|c| c.set_perf_monitor(Some(fps.monitor.clone())));
        *self.fps.borrow_mut() = Some(fps);
        self.ensure_ticking();
    }

    /// The performance monitor, while one measures.
    pub(crate) fn fps(&self) -> Option<Rc<crate::fps::Fps>> {
        self.fps.borrow().clone()
    }

    /// Starts `config`'s app, replacing what ran.
    pub(crate) fn start(self: &Rc<Self>, mut config: EngineConfig) {
        self.stop();
        crate::image::set_assets(self, config.assets.clone());
        let env = self.environment.get();
        config.viewport = env.window;
        config.environment = env;
        // A test session's app: the test's storage, network and trace.
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.test_model.borrow() {
            model.set_up_engine(&mut config);
        }
        let (tx, rx) = crossbeam_channel::unbounded();
        let pending = Arc::new(AtomicBool::new(false));
        let sink = Sink {
            hwnd: self.hwnd.clone(),
            tx,
            pending: pending.clone(),
            wake: self.terminal_wake.borrow().clone(),
        };
        *self.rx.borrow_mut() = Some(rx);
        *self.pending.borrow_mut() = pending;
        let family = crate::text::ui_family();
        // The embedding app's theme overrides are in the first frame.
        let tokens = self.host_tokens.borrow().clone();
        let setup = |control: &EngineControl| {
            if tokens.is_some() {
                control.set_tokens(tokens);
            }
        };
        match Engine::start_with(config, move || DWriteTextEngine::new(family), sink, setup) {
            Ok(engine) => {
                // The app's downloaded images go through its disk cache.
                crate::image::set_disk_cache(self, engine.image_cache());
                // The test moves its clock through the engine.
                #[cfg(feature = "dev")]
                if let Some(model) = &*self.test_model.borrow() {
                    model.engine_started(engine.control());
                }
                if let Some(fps) = &*self.fps.borrow() {
                    engine.control().set_perf_monitor(Some(fps.monitor.clone()));
                }
                *self.control.borrow_mut() = Some(engine.control());
                *self.engine.borrow_mut() = Some(engine);
            }
            Err(err) => {
                log::error!("cannot start the engine: {err}");
                if let Some(handler) = &*self.on_error.borrow() {
                    handler(&err.to_string());
                }
            }
        }
    }

    /// Stops the app and removes its views.
    pub(crate) fn stop(&self) {
        crate::text_input::stopped(self);
        crate::input::cancel_keyboard_press(self);
        // Dropping the engine joins its thread.
        self.control.borrow_mut().take();
        self.engine.borrow_mut().take();
        self.rx.borrow_mut().take();
        self.mounter.borrow_mut().clear();
        self.native.clear();
        crate::image::set_assets(self, None);
        crate::system::clear(self);
        *self.anim.borrow_mut() = UiAnimation::default();
        self.nav.borrow_mut().reset();
        crate::input::reset(self);
        crate::keymap::clear(self);
        self.js_frame.set(false);
        self.resize_late.set(false);
        self.frame_clients.borrow_mut().clear();
        self.ticker.borrow_mut().take();
        self.events_handled.set(0);
        self.invalidate();
    }

    #[cfg(feature = "terminal")]
    pub(crate) fn running(&self) -> bool {
        self.engine.borrow().is_some()
    }

    /// Calls `f` with the engine's control, if an app runs.
    pub(crate) fn control(&self, f: impl FnOnce(&EngineControl)) {
        if let Some(control) = &*self.control.borrow() {
            f(control);
        }
    }

    /// The native keyboard owner followed by its mounted ancestors.
    pub(crate) fn focus_path(&self) -> Vec<NodeId> {
        let mut current = crate::native::focused(self)
            .or_else(|| crate::text_input::focused_view(self))
            .filter(NshView::attached);
        let mut path = Vec::new();
        while let Some(view) = current {
            let state = view.state();
            if state.style.hidden
                || state.concealed
                || state.props.pointer_events == nsh_core::PointerEvents::None
            {
                return Vec::new();
            }
            drop(state);
            path.push(view.id());
            current = view.parent_view();
        }
        path
    }

    pub(crate) fn sync_focus(&self) {
        self.control(|control| control.set_focus_path(self.focus_path()));
    }

    /// Sends an event to JS.
    pub(crate) fn event(&self, id: NodeId, kind: EventKind, payload: EventPayload) {
        self.control(|c| {
            c.set_focus_path(self.focus_path());
            c.dispatch_event(id, kind, payload);
        });
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

    /// The view of node `id`.
    pub(crate) fn view(&self, id: NodeId) -> Option<NshView> {
        self.views.get(id)
    }

    /// Reports fatal app errors to an embedding host.
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

    /// The window's client area is `pixels` big at `scale` pixels per point.
    pub(crate) fn resized(self: &Rc<Self>, pixels: (u32, u32), scale: f32) {
        self.pixels.set(pixels);
        let scale_changed = (self.scale.replace(scale) - scale).abs() > f32::EPSILON;
        let width = pixels.0 as f32 / scale;
        let height = pixels.1 as f32 / scale;
        {
            let mut s = self.root.state_mut();
            if !scale_changed && s.frame.size.width.0 == width && s.frame.size.height.0 == height {
                return;
            }
            s.frame.size.width.0 = width;
            s.frame.size.height.0 = height;
        }
        let mut env = self.environment.get();
        env.window = Size::new(Points(width), Points(height));
        env.pixel_ratio = scale;
        self.environment.set(env);
        self.control(|c| {
            c.resize(Size::new(Points(width), Points(height)));
            c.set_environment(env);
        });
        crate::navigation::surface_resized(self, width, height);
        crate::system::surface_resized(self, width, height);
        for f in self.on_resized.borrow().iter() {
            f(width, height);
        }
        self.await_layout(Size::new(Points(width), Points(height)));
        self.invalidate();
    }

    /// Waits for the engine's layout at `size` and applies what it sent
    /// meanwhile, so the frame `WM_SIZE` draws shows the app at the window's
    /// new size rather than growing around stale content. The one place the
    /// main thread waits for the engine: at most [`RESIZE_WAIT`], and an
    /// engine that misses it (JS busy) is not waited for again until it
    /// reports a resize done, so a busy app resizes as before.
    fn await_layout(self: &Rc<Self>, size: Size<Points>) {
        if self.resize_late.get()
            || size.width.0 <= 0.0
            || size.height.0 <= 0.0
            || self.mounter.try_borrow_mut().is_err()
            || self.control.borrow().is_none()
        {
            return;
        }
        let Some(rx) = self.rx.borrow().clone() else {
            return;
        };
        let deadline = std::time::Instant::now() + RESIZE_WAIT;
        let mut applied = false;
        loop {
            let Ok(message) = rx.recv_deadline(deadline) else {
                self.resize_late.set(true);
                break;
            };
            let done = matches!(message, Message::Resized(s) if s == size);
            applied |= self.handle(message);
            if done {
                break;
            }
        }
        if applied {
            self.write_animations();
            self.ensure_ticking();
        }
    }

    /// Asks for the whole window to be drawn again (once, however often
    /// asked before it is).
    pub(crate) fn invalidate(&self) {
        self.full_damage.set(true);
        self.whole_change.set(crate::view::next_change_stamp());
        self.request_paint();
    }

    /// The change stamp of the last request to draw the whole window
    /// ([`Surface::invalidate`]). What such a request redraws may have
    /// changed without a view saying so (a video's frame, a native
    /// component, the theme): a shader's picture of its children taken
    /// before it is taken again.
    pub(crate) fn whole_change(&self) -> u64 {
        self.whole_change.get()
    }

    /// Asks for `view` and its subtree to be drawn again: where it was
    /// drawn and where it draws now ([`Surface::take_damage`]).
    pub(crate) fn invalidate_view(&self, view: &NshView) {
        if !self.full_damage.get() {
            view.set_queued(true);
            self.dirty.borrow_mut().push(view.clone());
        }
        self.request_paint();
    }

    fn request_paint(&self) {
        if let Some(wake) = &*self.terminal_wake.borrow() {
            wake();
        }
        if !self.invalid.replace(true) {
            crate::window::invalidate(self.hwnd());
        }
    }

    /// What changed since the last frame, in the window's DIPs: where the
    /// changed views were painted and where they draw now. `None`: the
    /// whole window (asked for, or a change whose area is not known).
    pub(crate) fn take_damage(&self) -> Option<Vec<crate::view::WindowRect>> {
        let dirty = std::mem::take(&mut *self.dirty.borrow_mut());
        for view in &dirty {
            view.set_queued(false);
        }
        if self.full_damage.replace(false) {
            return None;
        }
        let mut rects = Vec::with_capacity(dirty.len() * 2);
        for view in &dirty {
            if let Some(old) = view.painted_subtree() {
                rects.push(old);
            }
            let Some(world) = view.to_root() else {
                // Out of the tree: only where it was.
                continue;
            };
            if !world.is_affine() {
                return None;
            }
            // Hosted items may draw outside their rectangles.
            rects.push(
                crate::render::drawn_area(view)
                    .map(|area| crate::compose::map_bounds(&world.to_3x2(), &area))?,
            );
        }
        // Asked to draw with nothing changed (the system's `WM_PAINT`).
        (!rects.is_empty()).then_some(rects)
    }

    /// Draws the window (`WM_PAINT`).
    pub(crate) fn paint(self: &Rc<Self>) {
        self.invalid.set(false);
        crate::render::frame(self);
    }

    /// Hosted items drawn by the frame just shown, with their window
    /// rectangles: tells them, and the ones no longer drawn. `redrawn`: the
    /// areas (pixels) a partial frame drew; items it did not reach outside
    /// them stay where they were.
    pub(crate) fn items_placed(
        &self,
        drawn: Vec<(Rc<dyn Hosted>, RECT)>,
        redrawn: Option<&[RECT]>,
    ) {
        let mut placed = self.placed.borrow_mut();
        let mut next: Vec<(Rc<dyn Hosted>, RECT)> = Vec::with_capacity(drawn.len());
        for (item, rect) in drawn {
            // A partial frame draws its areas one by one.
            if !next.iter().any(|(i, _)| Rc::ptr_eq(i, &item)) {
                next.push((item, rect));
            }
        }
        for (old, rect) in placed.iter() {
            if next.iter().any(|(item, _)| Rc::ptr_eq(item, old)) {
                continue;
            }
            let untouched =
                redrawn.is_some_and(|areas| !areas.iter().any(|a| crate::render::overlap(a, rect)));
            if untouched {
                next.push((old.clone(), *rect));
            } else {
                old.placed(None);
            }
        }
        for (item, rect) in &next {
            item.placed(Some(*rect));
        }
        *placed = next;
    }

    /// The window's composition, if it has web views.
    pub(crate) fn composition(&self) -> Option<Rc<crate::compose::Composition>> {
        self.composition.borrow().upgrade()
    }

    /// The window's composition, made for a web view if there is none.
    pub(crate) fn compose(&self) -> windows::core::Result<Rc<crate::compose::Composition>> {
        if let Some(c) = self.composition() {
            return Ok(c);
        }
        let hwnd = self.hwnd();
        if hwnd.is_invalid() {
            return Err(windows::core::Error::from_hresult(
                windows::Win32::Foundation::E_HANDLE,
            ));
        }
        let c = crate::compose::Composition::new(hwnd)?;
        *self.composition.borrow_mut() = Rc::downgrade(&c);
        Ok(c)
    }

    /// The composed items the frame just shown drew, where they go, and
    /// the layers it drew (how many items are below each): tells them, and
    /// the ones no longer drawn, and stacks them.
    pub(crate) fn composed_placed(
        &self,
        composition: Option<&crate::compose::Composition>,
        composed: Vec<crate::render::Composed>,
        layers: &[usize],
    ) {
        let old = std::mem::replace(
            &mut *self.composed.borrow_mut(),
            composed.iter().map(|c| c.item.clone()).collect(),
        );
        if old.is_empty() && composed.is_empty() {
            return;
        }
        for item in &old {
            if !composed.iter().any(|c| Rc::ptr_eq(&c.item, item)) {
                item.compose_at(None);
            }
        }
        let mut visuals = Vec::with_capacity(composed.len());
        for c in &composed {
            c.item.compose_at(Some(&c.at));
            if let Some(v) = c.item.visual() {
                visuals.push(v);
            }
        }
        if let Some(composition) = composition {
            composition.arrange(&visuals, layers);
        }
    }

    /// Applies what the engine sent (`WM_NSH_WAKE`).
    pub(crate) fn drain(self: &Rc<Self>) {
        let started = self
            .fps
            .borrow()
            .as_ref()
            .map(|_| std::time::Instant::now());
        self.pending.borrow().store(false, Ordering::Release);
        let messages: Vec<Message> = match &*self.rx.borrow() {
            Some(rx) => rx.try_iter().collect(),
            None => return,
        };
        let mut applied = false;
        for message in messages {
            applied |= self.handle(message);
        }
        if applied {
            self.write_animations();
        }
        self.ensure_ticking();
        if let (Some(started), Some(fps)) = (started, self.fps()) {
            fps.drained(started.elapsed(), applied);
        }
    }

    /// Handles what the engine sent; true when it applied a batch.
    fn handle(self: &Rc<Self>, message: Message) -> bool {
        match message {
            Message::Batch(batch) => {
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
            Message::Handled(events) => {
                self.events_handled.set(events);
                crate::text_input::engine_caught_up(self);
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
        crate::access::batch_applied(self);
        crate::input::batch_applied(self);
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
        // Shader views whose uniforms moved start rendering now that the
        // graph is not borrowed.
        crate::shader::start_pending();
        // No surface state borrowed while the app's components run.
        crate::native::component_animated(self, moved);
        crate::scroll::pin_animated_sticky(self);
        if !finished.is_empty() {
            self.control(|c| c.animations_finished(finished));
        }
    }

    /// Calls `f` on every frame (with the frame's time) until it returns
    /// false: transitions, scroll glides, spinners.
    pub(crate) fn on_frame(self: &Rc<Self>, f: impl FnMut(&Rc<Surface>, f64) -> bool + 'static) {
        self.frame_clients.borrow_mut().push(Box::new(f));
        self.ensure_ticking();
    }

    /// Whether a native animation runs: the graph's (not one looping
    /// forever, which no test step waits for), or the platform's own
    /// (transitions, scroll glides).
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.anim.borrow().finishing() || !self.frame_clients.borrow().is_empty()
    }

    /// Keeps the model `nsh test --target` steps see of the app
    /// ([`nsh_testing::agent::Model`]): every batch applied and every error
    /// go to it from now on.
    #[cfg(feature = "dev")]
    pub(crate) fn set_test_model(&self, model: Option<std::sync::Arc<nsh_testing::agent::Model>>) {
        *self.test_model.borrow_mut() = model;
    }

    pub(crate) fn wants_frames(&self) -> bool {
        self.fps.borrow().is_some()
            || self.js_frame.get()
            || self.anim.borrow().animating()
            || !self.frame_clients.borrow().is_empty()
    }

    /// Runs the frame ticker while animations run or JS wants a frame.
    pub(crate) fn ensure_ticking(self: &Rc<Self>) {
        if !self.wants_frames() {
            return;
        }
        let mut ticker = self.ticker.borrow_mut();
        match &*ticker {
            Some(t) => t.resume(),
            None => *ticker = crate::window::Ticker::start(self.hwnd()),
        }
    }

    /// One frame of the ticker (`WM_NSH_TICK`).
    pub(crate) fn tick(self: &Rc<Self>) {
        let started = self
            .fps
            .borrow()
            .as_ref()
            .map(|_| std::time::Instant::now());
        let moved = self.anim.borrow().animating()
            || self.js_frame.get()
            || !self.frame_clients.borrow().is_empty();
        let now = self.clock();
        self.now.set(now);
        if self.anim.borrow().animating() {
            self.anim.borrow_mut().tick(now);
            self.write_animations();
        }
        if self.js_frame.replace(false) {
            self.control(|c| c.frame());
        }
        let mut clients = std::mem::take(&mut *self.frame_clients.borrow_mut());
        clients.retain_mut(|f| f(self, now));
        // Clients added while running stay after the ones kept.
        let mut added = std::mem::take(&mut *self.frame_clients.borrow_mut());
        clients.append(&mut added);
        *self.frame_clients.borrow_mut() = clients;
        if let Some(t) = &*self.ticker.borrow() {
            if self.wants_frames() {
                t.ticked();
            } else {
                t.pause();
            }
        }
        if let (Some(started), Some(fps)) = (started, self.fps()) {
            fps.ticked(started.elapsed(), moved);
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        crate::text_input::disposed(self.key);
        let key = self.key;
        let empty = SURFACES
            .try_with(|s| {
                let mut s = s.borrow_mut();
                s.remove(&key);
                s.retain(|_, w| w.strong_count() > 0);
                s.is_empty()
            })
            .unwrap_or(false);
        if empty {
            crate::gfx::release_thread_resources();
        }
    }
}

#[cfg(test)]
mod activation_tests {
    use super::*;

    #[test]
    fn foreground_observer_follows_activation_and_deactivation() {
        let surface = Surface::new(Default::default());
        let (send, receive) = std::sync::mpsc::channel();
        *surface.on_activation.borrow_mut() =
            Some(Box::new(move |active| send.send(active).unwrap()));
        surface.activation_changed(false);
        surface.activation_changed(true);
        surface.activation_changed(true);
        surface.activation_changed(false);
        assert_eq!(receive.try_iter().collect::<Vec<_>>(), vec![true, false]);
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use nsh_core::Cursor;
    use windows::Win32::{
        Foundation::{LPARAM, POINT, WPARAM},
        Graphics::Gdi::ClientToScreen,
        UI::{
            Input::KeyboardAndMouse::{GetCapture, ReleaseCapture, SetCapture},
            WindowsAndMessaging::*,
        },
    };

    use super::*;

    // This test uses the desktop's actual cursor; ordinary crate tests open
    // no windows. Restore it even if an assertion fails.
    struct Desktop {
        hwnd: HWND,
        saved: CURSORINFO,
        timer: usize,
    }

    impl Desktop {
        fn tick(&self) {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                assert!(Instant::now() < deadline, "cursor test timer did not fire");
                let mut msg = MSG::default();
                // SAFETY: a local output message, removed from this thread's queue.
                if unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
                    if msg.hwnd == self.hwnd
                        && msg.message == WM_TIMER
                        && msg.wParam.0 == self.timer
                    {
                        return;
                    }
                    // SAFETY: dispatching a message obtained from this thread's queue.
                    unsafe {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                } else {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        }
    }

    impl Drop for Desktop {
        fn drop(&mut self) {
            // SAFETY: this test owns the timer, capture and window; the saved cursor
            // and screen position came from GetCursorInfo before it ran.
            unsafe {
                if self.timer != 0 {
                    let _ = KillTimer(Some(self.hwnd), self.timer);
                }
                let _ = ReleaseCapture();
                let _ = DestroyWindow(self.hwnd);
                let _ = SetCursorPos(self.saved.ptScreenPos.x, self.saved.ptScreenPos.y);
                SetCursor(Some(self.saved.hCursor));
            }
        }
    }

    fn cursor_info() -> CURSORINFO {
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: the output structure declares its size.
        unsafe { GetCursorInfo(&mut info) }.unwrap();
        info
    }

    fn apply_cursor(surface: &Rc<Surface>, cursor: Cursor) {
        let mut style = surface.root.state().style.clone();
        style.cursor = cursor;
        surface.apply(&MountBatch {
            items: vec![MountItem::ViewStyle { id: ROOT_ID, style }],
        });
    }

    #[test]
    #[ignore = "requires an interactive Windows desktop; moves and restores the mouse"]
    fn cursor_style_updates_without_mouse_motion() {
        let saved = cursor_info();
        let surface = Surface::new(Environment::default());
        let hwnd =
            crate::window::create(&surface, "NSH cursor regression", (320, 240), None).unwrap();
        let mut desktop = Desktop {
            hwnd,
            saved,
            timer: 0,
        };
        apply_cursor(&surface, Cursor::Crosshair);
        crate::window::show(hwnd);

        let mut at = POINT { x: 100, y: 100 };
        // SAFETY: a live test window and a point in its client area. The
        // pointer is positioned once; later style batches must update it.
        unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            )
            .unwrap();
            ClientToScreen(hwnd, &mut at).ok().unwrap();
            SetCursorPos(at.x, at.y).unwrap();
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            assert_eq!(
                WindowFromPoint(at),
                hwnd,
                "the test window must be under the mouse"
            );
            // Keep mouse input on this thread while observing the global
            // cursor, rather than relying on foreground activation policy.
            SetCapture(hwnd);
            assert_eq!(GetCapture(), hwnd);
            SendMessageW(
                hwnd,
                WM_SETCURSOR,
                Some(WPARAM(hwnd.0 as usize)),
                Some(LPARAM(HTCLIENT as isize)),
            );
            desktop.timer = SetTimer(Some(hwnd), 1, 30, None);
        }
        assert_ne!(desktop.timer, 0);
        // Let the initial physical move reach this window before checking
        // updates that must not depend on another move.
        // SAFETY: loads a shared system cursor.
        let initial = unsafe { LoadCursorW(None, IDC_CROSS) }.unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while cursor_info().hCursor != initial {
            if Instant::now() >= deadline {
                // SAFETY: queries this thread's cursor and the desktop's active window.
                let (local, foreground) = unsafe { (GetCursor(), GetForegroundWindow()) };
                panic!(
                    "initial crosshair did not appear: global={:?}, local={local:?}, foreground={foreground:?}, window={hwnd:?}, style={:?}, frame={:?}",
                    cursor_info().hCursor,
                    surface.root.state().style.cursor,
                    surface.root.state().frame
                );
            }
            desktop.tick();
        }

        for (cursor, expected) in [
            (Cursor::Pointer, Some(IDC_HAND)),
            (Cursor::None, None),
            (Cursor::Crosshair, Some(IDC_CROSS)),
        ] {
            desktop.tick();
            let before = cursor_info().ptScreenPos;
            assert_eq!(
                (before.x, before.y),
                (at.x, at.y),
                "mouse moved before {cursor:?}"
            );
            apply_cursor(&surface, cursor);
            // Read immediately after the batch, without another mouse event
            // or cursor request that could make the pre-fix code pass.
            let info = cursor_info();
            assert_eq!((info.ptScreenPos.x, info.ptScreenPos.y), (at.x, at.y));
            match expected {
                Some(id) => {
                    // SAFETY: loads a shared system cursor.
                    let expected = unsafe { LoadCursorW(None, id) }.unwrap();
                    assert_eq!(info.hCursor, expected, "cursor did not follow {cursor:?}");
                    assert_ne!(info.flags.0 & CURSOR_SHOWING.0, 0);
                }
                None => assert_eq!(info.flags.0 & CURSOR_SHOWING.0, 0, "cursor stayed visible"),
            }
        }
    }
}
