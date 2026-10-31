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
}

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
}

impl Sink {
    fn send(&self, message: Message) {
        let _ = self.tx.send(message);
        if !self.pending.swap(true, Ordering::AcqRel) {
            crate::window::wake(self.hwnd.load(Ordering::Acquire));
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

/// One engine and its views.
pub(crate) struct Surface {
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
    /// Where `asset:/` image URIs resolve ([`crate::image::set_asset_base`]).
    pub(crate) asset_base: RefCell<Option<crate::image::AssetBase>>,
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
    /// Keys the window takes before anything focused sees them (the
    /// standalone app's full screen, the dev host's reload).
    pub(crate) shortcuts: RefCell<Vec<ShortcutHandler>>,
}

impl Surface {
    /// A surface with no app and no window yet.
    pub(crate) fn new(environment: Environment) -> Rc<Surface> {
        let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
        let root = NshView::new(ROOT_ID, nsh_core::ViewKind::View);
        let mounter = Mounter::new(root.clone());
        let surface = Rc::new(Surface {
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
            asset_base: RefCell::new(None),
            image_cache: RefCell::new(None),
            native: Default::default(),
            keymap: Default::default(),
            placed: RefCell::default(),
            composition: RefCell::default(),
            composed: RefCell::default(),
            on_resized: RefCell::default(),
            shortcuts: RefCell::default(),
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

    /// The surface with `key`, if it is alive.
    pub(crate) fn by_key(key: u64) -> Option<Rc<Surface>> {
        SURFACES.with(|s| s.borrow().get(&key).and_then(Weak::upgrade))
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
        self.frame_clients.borrow_mut().clear();
        self.invalidate();
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
            .or_else(|| crate::text_input::focused(self))
            .filter(NshView::attached);
        let mut path = Vec::new();
        while let Some(view) = current {
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
        self.control(|c| c.dispatch_event(id, kind, payload));
    }

    /// The view of node `id`.
    pub(crate) fn view(&self, id: NodeId) -> Option<NshView> {
        self.views.get(id)
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
        self.invalidate();
    }

    /// Asks for the whole window to be drawn again (once, however often
    /// asked before it is).
    pub(crate) fn invalidate(&self) {
        self.full_damage.set(true);
        self.request_paint();
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
            match message {
                Message::Batch(batch) => {
                    self.apply(&batch);
                    applied = true;
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
            }
        }
        if applied {
            self.write_animations();
        }
        self.ensure_ticking();
        if let (Some(started), Some(fps)) = (started, self.fps()) {
            fps.drained(started.elapsed(), applied);
        }
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

    fn wants_frames(&self) -> bool {
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
        let key = self.key;
        let _ = SURFACES.try_with(|s| s.borrow_mut().remove(&key));
    }
}
