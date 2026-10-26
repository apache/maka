//! One surface: an engine thread and the views it mounts on GPUI's main
//! thread.
//!
//! The engine thread hands each commit to [`Sink`], which queues it and
//! sends one wake-up to the main thread ([`crate::rt::invoke`]); the main
//! thread drains the queue and applies every batch in order
//! ([`Surface::drain`]). Drawing is coalesced: changes mark the surface
//! invalid, and [`flush_all`] (which ends every main-thread entry point)
//! notifies the GPUI view showing it, which draws the tree in its next
//! frame ([`crate::render`]). Native animations and JS frame requests tick
//! on the window's frames ([`Surface::tick`], called while drawing) while
//! there is something to do.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{
    EventKind, EventPayload, MountBatch, MountItem, NodeId, Points, ROOT_ID, Size,
    overlay::HintObservation,
};
use nsh_engine::{AppError, Engine, EngineConfig, EngineControl, Environment, MountSink};
use rustc_hash::FxHashMap;

use crate::{
    animation::UiAnimation,
    mount::Mounter,
    text::GpuiTextEngine,
    view::{Hosted, NshView},
};

/// What the engine thread sends the main thread.
enum Message {
    Batch(MountBatch),
    Error(AppError),
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
    /// The surface to wake ([`Surface::by_key`]).
    key: u64,
    tx: Sender<Message>,
    /// A wake-up is on its way: no need for another.
    pending: Arc<AtomicBool>,
}

impl Sink {
    fn send(&self, message: Message) {
        let _ = self.tx.send(message);
        if !self.pending.swap(true, Ordering::AcqRel) {
            let key = self.key;
            crate::rt::invoke(move || {
                if let Some(surface) = Surface::by_key(key) {
                    surface.drain();
                }
            });
        }
    }
}

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        self.send(Message::Batch(batch));
    }

    fn report(&self, error: &AppError) {
        self.send(Message::Error(error.clone()));
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

/// Called when the app reports an error (development hosts show it).
pub(crate) type ErrorHandler = Box<dyn Fn(&AppError)>;

/// A handler as kept: shared, so it is called with nothing borrowed (it may
/// restart the app or set another handler).
type Handler<F> = RefCell<Option<Rc<F>>>;

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
    /// Popovers' native focus owners and return targets.
    pub(crate) focus_returns: RefCell<crate::focus_return::FocusReturns>,
    /// Last autoFocus request waiting for its input to be mounted.
    pub(crate) pending_auto_focus: RefCell<Option<NshView>>,
    /// Pointer input state ([`crate::input`]).
    pub(crate) input: crate::input::Input,
    engine: RefCell<Option<Engine>>,
    control: RefCell<Option<EngineControl>>,
    rx: RefCell<Option<Receiver<Message>>>,
    pending: RefCell<Arc<AtomicBool>>,
    /// Pixels per point (the window's scale factor).
    scale: Cell<f32>,
    /// The GPUI view drawing the surface ([`crate::app::AppView`]): notified
    /// when the surface changed.
    pub(crate) entity: Cell<Option<gpui::EntityId>>,
    /// The GPUI text system (fonts the engine thread shapes with, and the
    /// main thread draws with).
    pub(crate) text_system: RefCell<Option<Arc<gpui::TextSystem>>>,
    /// Where the surface was drawn last, in window coordinates (points):
    /// input arrives in window coordinates.
    pub(crate) origin: Cell<(f32, f32)>,
    /// A draw is requested.
    invalid: Cell<bool>,
    /// Mouse buttons pressed on the surface (bit per button): their moves
    /// and releases are the surface's wherever they happen.
    pub(crate) input_pressed: Cell<u8>,
    /// The mouse is over the surface.
    pub(crate) input_hovered: Cell<bool>,
    /// The environment the engine was last told about.
    pub(crate) environment: Cell<Environment>,
    /// The app's appearance (`nsh.json`, `setColorScheme`): the color
    /// scheme is the system's resolved with it ([`crate::system`]).
    pub(crate) appearance: Cell<nsh_core::platform::Appearance>,
    /// JS asked for a display frame.
    js_frame: Cell<bool>,
    /// Extra frame clients (transitions, glides, spinners): called on every
    /// frame until they return false ([`Surface::on_frame`]).
    frame_clients: RefCell<Vec<FrameClient>>,
    /// The model of a test session's app (`nsh test --target gpui`).
    #[cfg(feature = "dev")]
    test_model: RefCell<Option<std::sync::Arc<nsh_testing::agent::Model>>>,
    /// Frame statistics, while they are logged ([`crate::stats`]).
    pub(crate) stats: RefCell<Option<crate::stats::FrameStats>>,
    epoch: std::time::Instant,
    on_error: Handler<dyn Fn(&AppError)>,
    /// A dev session's error overlay: hears the errors besides `on_error`.
    #[cfg(feature = "dev")]
    on_dev_error: Handler<dyn Fn(&AppError)>,
    on_hot_update_failed: Handler<dyn Fn()>,
    /// Counts the apps stopped ([`Surface::stop`]): what an engine sent
    /// before is not applied to the next one.
    generation: Cell<u64>,
    /// Where `asset:/` image URIs resolve ([`crate::image::set_asset_base`]).
    pub(crate) asset_base: RefCell<Option<crate::image::AssetBase>>,
    /// The current load's source for image `asset:/` URIs.
    pub(crate) image_assets: RefCell<crate::image::AssetSource>,
    /// The disk cache of downloaded images ([`crate::image::set_disk_cache`]).
    pub(crate) image_cache: RefCell<Option<nsh_core::image::DiskCache>>,
    /// What the running app may reach (checked for image redirects).
    pub(crate) access: RefCell<Arc<nsh_core::access::Access>>,
    /// Videos, web views and registered native components.
    pub(crate) native: crate::native::NativeState,
    /// The app's keyboard shortcuts ([`crate::keymap`]).
    pub(crate) keymap: crate::keymap::KeymapState,
    /// Hosted items drawn by the last frame ([`Hosted::placed`]).
    placed: RefCell<Vec<Rc<dyn Hosted>>>,
    /// The window's chrome: title bar, menus ([`crate::chrome`]).
    pub(crate) chrome: crate::chrome::Chrome,
    /// Called after the surface is resized (development overlays).
    pub(crate) on_resized: RefCell<Vec<ResizeHandler>>,
    /// Keys the window takes before anything focused sees them (the
    /// standalone app's full screen, the dev host's reload).
    pub(crate) shortcuts: RefCell<Vec<ShortcutHandler>>,
    /// How many batches were applied.
    pub(crate) batches: Cell<u64>,
    /// The embedding app's theme ([`crate::AppView::set_theme`]): sent to
    /// every engine the surface starts, before its first frame.
    pub(crate) host_theme: RefCell<Option<nsh_base::Theme>>,
    /// The embedding app's appearance (dark or not), standing in for the
    /// window's ([`crate::AppView::set_appearance`]).
    pub(crate) host_dark: Cell<Option<bool>>,
    /// The embedding app's locale and text size, standing in for the
    /// system's ([`crate::AppView::set_locale`], `set_font_scale`).
    pub(crate) host_environment: Cell<nsh_core::platform::HostEnvironment>,
}

impl Surface {
    /// A surface with no app and no window yet.
    pub(crate) fn new(mut environment: Environment) -> Rc<Surface> {
        environment.native_focus_scopes = true;
        environment.fallback_key_bindings = true;
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
            focus_returns: RefCell::default(),
            pending_auto_focus: RefCell::default(),
            input: Default::default(),
            engine: RefCell::new(None),
            control: RefCell::new(None),
            rx: RefCell::new(None),
            pending: RefCell::new(Arc::new(AtomicBool::new(false))),
            scale: Cell::new(1.0),
            entity: Cell::new(None),
            text_system: RefCell::new(None),
            origin: Cell::new((0.0, 0.0)),
            invalid: Cell::new(false),
            input_pressed: Cell::new(0),
            input_hovered: Cell::new(false),
            environment: Cell::new(environment),
            appearance: Cell::default(),
            js_frame: Cell::new(false),
            frame_clients: RefCell::default(),
            #[cfg(feature = "dev")]
            test_model: RefCell::default(),
            stats: RefCell::new(None),
            epoch: std::time::Instant::now(),
            on_error: RefCell::new(None),
            #[cfg(feature = "dev")]
            on_dev_error: RefCell::new(None),
            on_hot_update_failed: RefCell::new(None),
            generation: Cell::new(0),
            asset_base: RefCell::new(None),
            image_assets: RefCell::default(),
            image_cache: RefCell::new(None),
            access: RefCell::new(Arc::default()),
            native: Default::default(),
            keymap: Default::default(),
            placed: RefCell::default(),
            on_resized: RefCell::default(),
            shortcuts: RefCell::default(),
            batches: Cell::new(0),
            chrome: Default::default(),
            host_theme: RefCell::new(None),
            host_dark: Cell::new(None),
            host_environment: Cell::default(),
        });
        SURFACES.with(|s| s.borrow_mut().insert(key, Rc::downgrade(&surface)));
        let weak = Rc::downgrade(&surface);
        root.set_invalidate(Rc::new(move || {
            if let Some(surface) = weak.upgrade() {
                surface.invalidate();
            }
        }));
        surface
    }

    /// The surface with `key`, if it is alive.
    pub(crate) fn by_key(key: u64) -> Option<Rc<Surface>> {
        SURFACES.with(|s| s.borrow().get(&key).and_then(Weak::upgrade))
    }

    /// Its key ([`Surface::by_key`]).
    pub(crate) fn key(&self) -> u64 {
        self.key
    }

    /// The surface's size in points.
    pub(crate) fn size(&self) -> (f32, f32) {
        let s = self.root.state();
        (s.frame.size.width.0, s.frame.size.height.0)
    }

    /// Seconds since the surface was made (the animation clock).
    pub(crate) fn clock(&self) -> f64 {
        self.epoch.elapsed().as_secs_f64()
    }

    /// Starts `config`'s app, replacing what ran.
    pub(crate) fn start(self: &Rc<Self>, mut config: EngineConfig, use_engine_assets: bool) {
        self.stop();
        *self.image_assets.borrow_mut() = if use_engine_assets {
            crate::image::AssetSource::Engine(config.assets.clone())
        } else {
            crate::image::AssetSource::Base
        };
        *self.access.borrow_mut() = Arc::new(match &config.app {
            nsh_engine::App::Js(bundle) => bundle.policy.access(),
            nsh_engine::App::Rust(_) => nsh_engine::Policy::default().access(),
        });
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
        };
        *self.rx.borrow_mut() = Some(rx);
        *self.pending.borrow_mut() = pending;
        let Some(text_system) = self.text_system.borrow().clone() else {
            log::error!("cannot start the engine: the surface is not in a GPUI app yet");
            return;
        };
        let family: Arc<str> = Arc::from(&*crate::text::ui_family_for(&text_system));
        let theme = self.host_theme.borrow().clone();
        match Engine::start_with(
            config,
            move || GpuiTextEngine::new(text_system, family),
            sink,
            |control| {
                if let Some(theme) = theme {
                    control.set_tokens(Some(theme.into_tokens()));
                }
            },
        ) {
            Ok(engine) => {
                // The app's downloaded images go through its disk cache.
                crate::image::set_disk_cache(self, engine.image_cache());
                // The test moves its clock through the engine.
                #[cfg(feature = "dev")]
                if let Some(model) = &*self.test_model.borrow() {
                    model.engine_started(engine.control());
                }
                *self.control.borrow_mut() = Some(engine.control());
                *self.engine.borrow_mut() = Some(engine);
            }
            Err(err) => log::error!("cannot start the engine: {err}"),
        }
    }

    /// Identifies this engine load, including while its image requests settle.
    pub(crate) fn load_generation(&self) -> u64 {
        self.generation.get()
    }

    /// Stops the app and removes its views.
    pub(crate) fn stop(&self) {
        self.generation.set(self.generation.get() + 1);
        *self.image_assets.borrow_mut() = crate::image::AssetSource::Base;
        *self.image_cache.borrow_mut() = None;
        // Dropping the engine joins its thread.
        self.control.borrow_mut().take();
        self.engine.borrow_mut().take();
        self.rx.borrow_mut().take();
        self.focus_returns.borrow_mut().clear();
        self.pending_auto_focus.borrow_mut().take();
        self.mounter.borrow_mut().clear();
        self.native.clear();
        crate::system::clear(self);
        *self.anim.borrow_mut() = UiAnimation::default();
        self.nav.borrow_mut().reset();
        crate::input::reset(self);
        crate::keymap::clear(self);
        crate::text_input::surface_stopped(self.key);
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

    /// The native keyboard owner and its ancestors, including a transfer
    /// awaiting the next window frame. Reading focus does not run JS, and
    /// is safe while navigation applies a mount item.
    pub(crate) fn focus_path(&self) -> Vec<NodeId> {
        if crate::system::has_dialog(self) || crate::chrome::menu_open(self) {
            return Vec::new();
        }
        let target = crate::native::requested_focus(self)
            .and_then(|id| self.view(id))
            .map(crate::text_input::FocusTarget::View)
            .or_else(|| crate::text_input::focused_target(self));
        let mut view = target
            .as_ref()
            .map(|target| target.view().clone())
            .or_else(|| crate::native::focused_component(self).and_then(|id| self.view(id)));
        let mut path = Vec::new();
        if let Some(target) = &target
            && target.id() != target.view().id()
        {
            path.push(target.id());
        }
        while let Some(node) = view {
            let s = node.state();
            if !node.attached()
                || s.style.hidden
                || s.concealed
                || s.props.pointer_events == nsh_core::PointerEvents::None
            {
                return Vec::new();
            }
            path.push(s.id);
            view = node.parent_view();
        }
        path
    }

    /// Publishes native focus without running JS or subscribing effects.
    pub(crate) fn sync_focus(&self) {
        self.control(|c| c.set_focus_path(self.focus_path()));
    }

    /// Sends an event after the matching native focus snapshot, through
    /// the same engine FIFO.
    pub(crate) fn event(&self, id: NodeId, kind: EventKind, payload: EventPayload) {
        if matches!(kind, EventKind::HoverIn | EventKind::HoverOut)
            && let Some(events) = self.view(id).map(|view| view.state().events)
            && events.contains(kind)
            && !events.contains_listener(kind)
        {
            if let Some(watch) = events.hint_watch() {
                self.observe_hint(match kind {
                    EventKind::HoverIn => HintObservation::Enter(watch),
                    _ => HintObservation::Leave(watch),
                });
            }
            return;
        }
        self.control(|c| {
            c.set_focus_path(self.focus_path());
            c.dispatch_event(id, kind, payload);
        });
    }

    /// Sends a passive hint observation after the matching native focus
    /// snapshot, through the same engine FIFO as events.
    pub(crate) fn observe_hint(&self, observation: HintObservation) {
        self.control(|c| {
            c.set_focus_path(self.focus_path());
            c.observe_hint(observation);
        });
    }

    /// The view of node `id`.
    pub(crate) fn view(&self, id: NodeId) -> Option<NshView> {
        self.views.get(id)
    }

    /// Shows fatal app errors with `f` (development hosts, embedding apps).
    pub(crate) fn set_error_handler(&self, f: ErrorHandler) {
        *self.on_error.borrow_mut() = Some(Rc::from(f));
    }

    /// Shows fatal app errors with `f` too, besides the handler of
    /// [`Surface::set_error_handler`] (a dev session's overlay).
    #[cfg(feature = "dev")]
    pub(crate) fn set_dev_error_handler(&self, f: ErrorHandler) {
        *self.on_dev_error.borrow_mut() = Some(Rc::from(f));
    }

    /// Runs `f` when a hot update could not be applied in place.
    #[cfg(feature = "dev")]
    pub(crate) fn set_hot_update_failed(&self, f: impl Fn() + 'static) {
        *self.on_hot_update_failed.borrow_mut() = Some(Rc::new(f));
    }

    /// Updates the environment and tells the engine, with the embedding
    /// app's settings over the system's.
    pub(crate) fn set_environment(&self, mut environment: Environment) {
        self.host_environment.get().apply(&mut environment);
        environment.native_focus_scopes = true;
        environment.fallback_key_bindings = true;
        if self.environment.replace(environment) != environment {
            self.control(|c| {
                c.set_focus_path(self.focus_path());
                c.set_environment(environment);
            });
            crate::system::environment_applied(self);
        }
    }

    /// The surface is drawn `width` × `height` points big at `scale`
    /// pixels per point.
    pub(crate) fn resized(self: &Rc<Self>, width: f32, height: f32, scale: f32) {
        let scale_changed = (self.scale.replace(scale) - scale).abs() > f32::EPSILON;
        {
            let mut s = self.root.state_mut();
            if !scale_changed && s.frame.size.width.0 == width && s.frame.size.height.0 == height {
                return;
            }
            s.frame.size.width.0 = width;
            s.frame.size.height.0 = height;
        }
        let mut env = self.environment.get();
        env.window = nsh_core::Size::new(nsh_core::Points(width), nsh_core::Points(height));
        env.pixel_ratio = scale;
        self.environment.set(env);
        self.control(|c| {
            c.set_focus_path(self.focus_path());
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

    /// Asks for the surface to be drawn again (once, however often asked
    /// before it is): [`flush_all`] notifies its view.
    pub(crate) fn invalidate(&self) {
        if !self.invalid.replace(true) {
            // Entry points flush when they end; a change made anywhere else
            // (a GPUI callback, an observer) is flushed by the main-thread
            // queue, which flushes after its jobs: GPUI's retained frames
            // never show a stale tree.
            crate::rt::invoke(|| {});
        }
    }

    /// It changed since it was last drawn.
    pub(crate) fn invalidated(&self) -> bool {
        self.invalid.get()
    }

    /// The surface is being drawn: what changed so far is in this frame.
    pub(crate) fn drawing(&self) {
        self.invalid.set(false);
    }

    /// Hosted items drawn by the frame just drawn, with their window
    /// bounds: tells them, and the ones no longer drawn.
    pub(crate) fn items_placed(&self, drawn: Vec<(Rc<dyn Hosted>, gpui::Bounds<gpui::Pixels>)>) {
        let mut placed = self.placed.borrow_mut();
        for old in placed.iter() {
            if !drawn.iter().any(|(item, _)| Rc::ptr_eq(item, old)) {
                old.placed(None);
            }
        }
        placed.clear();
        for (item, rect) in drawn {
            item.placed(Some(rect));
            placed.push(item);
        }
    }

    /// Applies what the engine sent.
    pub(crate) fn drain(self: &Rc<Self>) {
        self.pending.borrow().store(false, Ordering::Release);
        let messages: Vec<Message> = match &*self.rx.borrow() {
            Some(rx) => rx.try_iter().collect(),
            None => return,
        };
        let generation = self.generation.get();
        let mut applied = false;
        for message in messages {
            // A handler restarted or stopped the app: the rest was the old
            // engine's.
            if self.generation.get() != generation {
                return;
            }
            match message {
                Message::Batch(batch) => {
                    self.apply(&batch);
                    applied = true;
                    self.batches.set(self.batches.get() + 1);
                }
                Message::Error(error) => {
                    log::error!("{error}");
                    #[cfg(feature = "dev")]
                    if let Some(model) = &*self.test_model.borrow() {
                        model.error(error.to_string());
                    }
                    #[cfg(feature = "dev")]
                    {
                        let handler = self.on_dev_error.borrow().clone();
                        if let Some(f) = handler {
                            f(&error);
                        }
                    }
                    let handler = self.on_error.borrow().clone();
                    if let Some(f) = handler {
                        f(&error);
                    }
                }
                Message::Frame => self.js_frame.set(true),
                Message::HotUpdateFailed => {
                    let handler = self.on_hot_update_failed.borrow().clone();
                    if let Some(f) = handler {
                        f();
                    }
                }
            }
        }
        if applied {
            self.write_animations();
            // Views may have come under (or gone from under) a still mouse.
            crate::input::rehover(self);
        }
        self.ensure_ticking();
    }

    fn apply(self: &Rc<Self>, batch: &MountBatch) {
        let focused = crate::input::focus_chain(self);
        let mut focus_return = crate::focus_return::before_batch(self, batch);
        crate::access::prepare(batch);
        for item in &batch.items {
            if let MountItem::Delete { id } = item
                && self.view(*id).is_none()
            {
                crate::focus_return::retire_link_before(focus_return.as_mut(), *id);
            }
            if let MountItem::Remove { id } | MountItem::Delete { id } = item
                && let Some(root) = self.view(*id)
            {
                crate::focus_return::retire_before(focus_return.as_mut(), &root);
            }
            if matches!(
                item,
                MountItem::Command {
                    command: nsh_core::Command::Focus | nsh_core::Command::Blur,
                    ..
                }
            ) {
                // Explicit focus changes supersede preceding autoFocus
                // requests, including inputs configured before insertion.
                self.pending_auto_focus.borrow_mut().take();
            }
            self.anim.borrow_mut().apply(item);
            if !matches!(
                item,
                MountItem::Animation(_) | MountItem::AnimationBindings { .. }
            ) {
                self.mounter.borrow_mut().apply(self, item);
            }
            if focus_return.is_some()
                && matches!(
                    item,
                    MountItem::Command {
                        command: nsh_core::Command::Blur,
                        ..
                    }
                )
            {
                crate::focus_return::after_blur(self, batch);
            }
        }
        crate::text_input::apply_auto_focus(self);
        self.mounter.borrow_mut().end_batch(self);
        if let Some(view) = crate::text_input::focused_view(self)
            && !crate::input::focusable(self, &view)
        {
            crate::text_input::blur_view(self, &view);
        }
        crate::focus_return::after_batch(self, batch, focus_return);
        crate::input::focus_within_changed(self, &focused);
        let tracked: Vec<_> = batch
            .items
            .iter()
            .filter_map(|item| match item {
                MountItem::TrackStates { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        crate::input::refresh_tracked_states(self, &tracked);
        // Removed owners are cleared quietly by focused_view; publish that
        // fact even when there is no remaining node to receive Blur.
        self.sync_focus();
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.test_model.borrow() {
            model.apply(batch);
        }
        crate::access::batch_applied(self);
        crate::selectable_view::batch_applied(self);
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

    /// Calls `f` on every frame (with the frame's time) until it returns
    /// false: transitions, scroll glides, spinners.
    pub(crate) fn on_frame(self: &Rc<Self>, f: impl FnMut(&Rc<Surface>, f64) -> bool + 'static) {
        self.frame_clients.borrow_mut().push(Box::new(f));
        self.ensure_ticking();
    }

    /// Whether a native animation runs: the graph's, or the platform's own
    /// (scroll glides).
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.anim.borrow().animating() || !self.frame_clients.borrow().is_empty()
    }

    /// Keeps the model `nsh test --target` steps see of the app
    /// ([`nsh_testing::agent::Model`]): every batch applied and every error
    /// go to it from now on.
    #[cfg(feature = "dev")]
    pub(crate) fn set_test_model(&self, model: Option<std::sync::Arc<nsh_testing::agent::Model>>) {
        *self.test_model.borrow_mut() = model;
    }

    /// Something animates or JS wants a frame: the view keeps drawing
    /// frames ([`crate::render`]).
    pub(crate) fn wants_frames(&self) -> bool {
        self.js_frame.get()
            || self.anim.borrow().animating()
            || !self.frame_clients.borrow().is_empty()
    }

    /// Draws frames while animations run or JS wants a frame.
    pub(crate) fn ensure_ticking(self: &Rc<Self>) {
        if self.wants_frames() {
            self.invalidate();
        }
    }

    /// One animation frame (called while the surface is drawn, before its
    /// views are).
    pub(crate) fn tick(self: &Rc<Self>) {
        let now = self.clock();
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
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        let key = self.key;
        let _ = SURFACES.try_with(|s| s.borrow_mut().remove(&key));
    }
}

/// Notifies the views of this thread's surfaces that changed.
pub(crate) fn flush_all(cx: &mut gpui::App) {
    let ids: Vec<gpui::EntityId> = SURFACES.with(|s| {
        s.borrow()
            .values()
            .filter_map(Weak::upgrade)
            .filter(|surface| surface.invalid.get())
            .filter_map(|surface| {
                if let Some(stats) = surface.stats.borrow_mut().as_mut() {
                    stats.notified();
                }
                surface.entity.get()
            })
            .collect()
    });
    for id in ids {
        cx.notify(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "js")]
    #[gpui::test]
    fn real_popover_inside_and_outside_bursts_follow_native_input(cx: &mut gpui::TestAppContext) {
        use std::time::{Duration, Instant};

        use crate::input::{PointerEvent, PointerKind};

        const APP: &str = r#"
            import { mount, signal, inputAction, View, Text } from 'nsh';
            import { Popover, Button } from 'nsh/base';
            const inside = signal(0);
            const outside = signal(0);
            const outsideAction = signal(0);
            const open = signal(true);
            const increment = () => inside.set(inside() + 1);
            const incrementOutside = () => outsideAction.set(outsideAction() + 1);
            mount(() => View({style: {flex: 1}, children: [
                Popover({get open() { return open(); }, popupStyle: {width: 240},
                    onOpenChange: next => { open.set(next); if (!next) outside.set(outside() + 1); },
                    trigger: Button({accessibilityLabel: 'Open popup',
                        style: {width: 160, height: 40}, children: Text({children: 'Open popup'})}),
                    children: Button({accessibilityLabel: 'Inside action', tooltip: 'Inside hint',
                        onPress: inputAction(increment, null), style: {width: 200, height: 48},
                        hoverStyle: {backgroundColor: '#334455'}, children: Text({children: 'Inside action'})})}),
                Text({get accessibilityLabel() { return `Inside count ${inside()}`; }, children: () => `Inside count ${inside()}`}),
                Text({get accessibilityLabel() { return `Outside count ${outside()}`; }, children: () => `Outside count ${outside()}`}),
                Text({get accessibilityLabel() { return `Popup open ${open()}`; }, children: () => `Popup open ${open()}`}),
                Text({get accessibilityLabel() { return `Outside action count ${outsideAction()}`; }, children: () => `Outside action count ${outsideAction()}`}),
                Button({accessibilityLabel: 'Outside action', onPress: inputAction(incrementOutside, null),
                    style: {position: 'absolute', left: 400, top: 250, width: 180, height: 48},
                    children: Text({children: 'Outside action'})})
            ]}));
        "#;
        fn target(view: &NshView, label: &str) -> Option<NshView> {
            if view.state().props.accessibility.label.as_deref() == Some(label) {
                return Some(view.clone());
            }
            view.with_children(|children| children.iter().find_map(|view| target(view, label)))
        }
        fn wait(surface: &Rc<Surface>, ready: impl Fn() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let (tx, rx) = crossbeam_channel::bounded(1);
                surface.control(|control| {
                    control.advance_clock(Duration::ZERO, move || tx.send(()).unwrap());
                });
                rx.recv_timeout(Duration::from_secs(5)).unwrap();
                surface.drain();
                if ready() {
                    return;
                }
                assert!(Instant::now() < deadline, "real Popover did not settle");
            }
        }
        cx.executor().allow_parking();
        let (surface, _app) = cx.update(|cx| {
            let app = crate::rt::init_test_app(cx);
            let environment = nsh_engine::Environment {
                os: nsh_core::platform::Os::Linux,
                idiom: nsh_core::platform::Idiom::Desktop,
                renderer: nsh_core::platform::Renderer::Native,
                ..Default::default()
            };
            let surface = Surface::new(environment);
            surface.set_error_handler(Box::new(|error| {
                panic!("real Popover startup failed: {error:?}");
            }));
            surface.resized(640.0, 384.0, 1.0);
            *surface.text_system.borrow_mut() = Some(cx.text_system().clone());
            surface.start(
                EngineConfig {
                    ui_sets: vec![nsh_base::registry()],
                    ..EngineConfig::new(nsh_engine::App::Js(nsh_engine::Bundle::source(APP.into())))
                },
                false,
            );
            (surface, app)
        });
        wait(&surface, || {
            target(&surface.root, "Inside action").is_some_and(|view| {
                view.state().events.contains(EventKind::Press)
                    && view.state().frame.size.height.0 > 0.0
            })
        });
        let button = target(&surface.root, "Inside action").unwrap();
        let size = button.state().frame.size;
        let (x, y) = button
            .to_root()
            .unwrap()
            .map(size.width.0 / 2.0, size.height.0 / 2.0)
            .unwrap();
        crate::input::pointer(
            &surface,
            PointerEvent {
                kind: PointerKind::Move,
                x,
                y,
                button: 0,
                pointer: 1,
                touch: false,
                pen: false,
                time: surface.clock(),
                modifiers: Default::default(),
                clicks: 1,
            },
        );
        // The complete physical burst reaches the ordinary native handlers
        // without another draw or engine pump between hover, Down and Up.
        for kind in [PointerKind::Down, PointerKind::Up] {
            crate::input::pointer(
                &surface,
                PointerEvent {
                    kind,
                    x,
                    y,
                    button: 0,
                    pointer: 1,
                    touch: false,
                    pen: false,
                    time: surface.clock(),
                    modifiers: Default::default(),
                    clicks: 1,
                },
            );
        }
        wait(&surface, || {
            target(&surface.root, "Inside count 1").is_some()
        });
        assert!(target(&surface.root, "Outside count 0").is_some());
        let outside = target(&surface.root, "Outside action").unwrap();
        let size = outside.state().frame.size;
        let (outside_x, outside_y) = outside
            .to_root()
            .unwrap()
            .map(size.width.0 / 2.0, size.height.0 / 2.0)
            .unwrap();
        // Closing the popup must not consume the legitimate outside button's
        // action. This second burst also has no intervening pump or draw.
        for kind in [PointerKind::Move, PointerKind::Down, PointerKind::Up] {
            crate::input::pointer(
                &surface,
                PointerEvent {
                    kind,
                    x: outside_x,
                    y: outside_y,
                    button: 0,
                    pointer: 1,
                    touch: false,
                    pen: false,
                    time: surface.clock(),
                    modifiers: Default::default(),
                    clicks: 1,
                },
            );
        }
        wait(&surface, || {
            target(&surface.root, "Outside count 1").is_some()
                && target(&surface.root, "Outside action count 1").is_some()
                && target(&surface.root, "Popup open false").is_some()
        });
        assert!(target(&surface.root, "Inside count 1").is_some());
        surface.stop();
    }

    #[cfg(feature = "js")]
    #[gpui::test]
    fn recycled_list_rows_keep_keyboard_order_and_retire_replaced_focus(
        cx: &mut gpui::TestAppContext,
    ) {
        use std::time::{Duration, Instant};

        const APP: &str = r#"
            import { mount, signal, View, Text, List } from 'nsh';
            import { LayoutAnimation } from 'nsh';
            const rows = signal(Array.from({length: 40}, (_, i) => `row ${i}`));
            const phase = signal('initial');
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
                action('Filter rows', () => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.linear);
                    rows.set(['match alpha', 'match beta']); phase.set('filtered');
                }),
                List({get each() { return rows(); }, keyExtractor: row => row,
                    ref: node => { list = node; }, estimatedItemSize: 32,
                    style: {height: 128}, focusable: false,
                    header: action('Header action', () => {}),
                    footer: action('Footer action', () => {}),
                    children: row => action(row, () => phase.set(row()))}),
                Text({children: () => phase()})
            ]}));
        "#;

        fn target(view: &NshView, label: &str) -> Option<NshView> {
            if view.state().props.accessibility.label.as_deref() == Some(label) {
                return Some(view.clone());
            }
            view.with_children(|children| children.iter().find_map(|view| target(view, label)))
        }
        fn wait(surface: &Rc<Surface>, stage: &str, ready: impl Fn() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let (tx, rx) = crossbeam_channel::bounded(1);
                surface.control(|control| {
                    control.advance_clock(Duration::ZERO, move || tx.send(()).unwrap());
                });
                rx.recv_timeout(Duration::from_secs(5)).unwrap();
                surface.drain();
                // A native frame also settles scroll extents after content shrinks.
                surface.tick();
                if ready() {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "native list did not settle: {stage}"
                );
            }
        }
        fn press(surface: &Rc<Surface>, label: &str) {
            surface.event(
                target(&surface.root, label).unwrap().id(),
                EventKind::Press,
                EventPayload::None,
            );
        }
        fn focused(surface: &Rc<Surface>) -> Option<String> {
            crate::text_input::focused_view(surface).and_then(|view| {
                view.state()
                    .props
                    .accessibility
                    .label
                    .as_deref()
                    .map(str::to_owned)
            })
        }
        fn tab(surface: &Rc<Surface>, shift: bool) {
            assert!(crate::input::key(
                surface,
                crate::input::KeyEvent {
                    vk: 0x09,
                    down: true,
                    repeat: false,
                    modifiers: crate::input::Modifiers {
                        shift,
                        ..Default::default()
                    },
                }
            ));
        }

        cx.executor().allow_parking();
        let (surface, _app) = cx.update(|cx| {
            let app = crate::rt::init_test_app(cx);
            let surface = Surface::new(nsh_engine::Environment::default());
            surface.resized(640.0, 384.0, 1.0);
            *surface.text_system.borrow_mut() = Some(cx.text_system().clone());
            surface.start(
                EngineConfig::new(nsh_engine::App::Js(nsh_engine::Bundle::source(APP.into()))),
                false,
            );
            (surface, app)
        });
        wait(&surface, "initial rows", || {
            target(&surface.root, "row 0").is_some()
        });
        press(&surface, "Scroll to twelve");
        wait(&surface, "scroll to twelve", || {
            target(&surface.root, "row 20").is_some()
        });
        let retained = target(&surface.root, "row 12").unwrap();
        assert!(crate::input::focus_view(&surface, &retained));
        tab(&surface, false);
        assert_eq!(focused(&surface).as_deref(), Some("row 13"));
        tab(&surface, true);
        assert_eq!(focused(&surface).as_deref(), Some("row 12"));

        press(&surface, "Scroll to thirteen");
        wait(&surface, "scroll to thirteen", || {
            target(&surface.root, "row 21").is_some()
        });
        assert_eq!(target(&surface.root, "row 12"), Some(retained));
        assert_eq!(focused(&surface).as_deref(), Some("row 12"));

        let replaced = target(&surface.root, "row 20").unwrap();
        assert!(crate::input::focus_view(&surface, &replaced));
        press(&surface, "Filter rows");
        wait(&surface, "filtered rows", || {
            target(&surface.root, "match beta").is_some()
        });
        assert_ne!(focused(&surface).as_deref(), Some("match alpha"));
        assert_ne!(focused(&surface).as_deref(), Some("match beta"));
        assert!(crate::input::focus_view(
            &surface,
            &target(&surface.root, "Header action").unwrap(),
        ));
        for label in ["match alpha", "match beta", "Footer action"] {
            tab(&surface, false);
            assert_eq!(focused(&surface).as_deref(), Some(label));
        }
        surface.stop();
    }

    fn focus_return_input(id: NodeId, parent: NodeId, auto_focus: bool) -> Vec<MountItem> {
        vec![
            MountItem::Create {
                id,
                kind: nsh_core::ViewKind::Input,
            },
            MountItem::Input {
                id,
                config: Box::new(nsh_core::InputConfig {
                    auto_focus,
                    ..Default::default()
                }),
            },
            MountItem::InputValue {
                id,
                text: "a中文bc".into(),
                count: 0,
            },
            MountItem::Insert {
                parent,
                child: id,
                before: None,
            },
        ]
    }

    #[test]
    fn list_cell_retirement_preserves_native_focus_but_source_removal_revokes_it() {
        use nsh_core::{ROOT_ID, ViewKind};

        use crate::geom::rect;
        let surface = Surface::new(nsh_engine::Environment::default());
        surface.root.state_mut().frame = rect(0.0, 0.0, 400.0, 200.0);
        let mut items = vec![
            MountItem::Create {
                id: 2,
                kind: ViewKind::View,
            },
            MountItem::Frame {
                id: 2,
                frame: rect(0.0, 0.0, 160.0, 32.0),
            },
            MountItem::ProjectRoot {
                parent: ROOT_ID,
                id: 2,
                following: vec![],
            },
        ];
        items.extend(focus_return_input(4, 2, true));
        items.extend(focus_return_input(6, ROOT_ID, false));
        items.push(MountItem::Frame {
            id: 4,
            frame: rect(0.0, 0.0, 160.0, 32.0),
        });
        items.push(MountItem::Frame {
            id: 6,
            frame: rect(200.0, 0.0, 160.0, 32.0),
        });
        surface.apply(&MountBatch { items });
        assert!(surface.focus_path().contains(&4));

        surface.apply(&MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 7,
                roots: vec![2],
            }],
        });
        assert!(surface.focus_path().contains(&4));
        assert!(surface.view(4).unwrap().attached());

        assert!(crate::input::focus_view(
            &surface,
            &surface.view(6).unwrap()
        ));
        surface.apply(&MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 8,
                roots: vec![2],
            }],
        });
        assert!(!surface.view(4).unwrap().attached());
        assert!(surface.focus_path().contains(&6));

        surface.apply(&MountBatch {
            items: vec![MountItem::ProjectRoot {
                parent: ROOT_ID,
                id: 2,
                following: vec![],
            }],
        });
        assert!(crate::input::focus_view(
            &surface,
            &surface.view(4).unwrap()
        ));
        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 2 }],
        });
        assert!(!surface.focus_path().contains(&4));
        assert!(!surface.view(4).unwrap().attached());

        surface.apply(&MountBatch {
            items: vec![
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![],
                },
                MountItem::Create {
                    id: 8,
                    kind: ViewKind::Native,
                },
                MountItem::Frame {
                    id: 8,
                    frame: rect(0.0, 0.0, 160.0, 32.0),
                },
                MountItem::Insert {
                    parent: 2,
                    child: 8,
                    before: None,
                },
            ],
        });
        assert!(crate::input::focus_view(
            &surface,
            &surface.view(6).unwrap()
        ));
        // Tab's native transfer waits for the next GPUI window frame;
        // the previous NSH owner remains until that transfer is applied.
        crate::input::focus_stop(
            &surface,
            &crate::text_input::FocusTarget::View(surface.view(8).unwrap()),
        );
        assert_eq!(crate::native::requested_focus(&surface), Some(8));
        assert_eq!(crate::text_input::focused_view(&surface).unwrap().id(), 6);
        assert_eq!(surface.focus_path(), vec![8, 2, ROOT_ID]);
        surface.apply(&MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 9,
                roots: vec![2],
            }],
        });
        assert!(surface.view(8).unwrap().attached());
        assert_eq!(crate::native::requested_focus(&surface), Some(8));
        assert_eq!(surface.focus_path(), vec![8, 2, ROOT_ID]);

        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 2 }],
        });
        assert_eq!(crate::native::requested_focus(&surface), None);
        assert!(!surface.focus_path().contains(&8));
        assert!(!surface.view(8).unwrap().attached());
    }

    #[test]
    fn list_cell_retirement_parks_and_restores_promoted_modal_roots_together() {
        use nsh_core::{ROOT_ID, ViewKind};

        use crate::geom::rect;
        let surface = Surface::new(nsh_engine::Environment::default());
        surface.root.state_mut().frame = rect(0.0, 0.0, 400.0, 200.0);
        let group = vec![2, 8, 12];
        let frame = rect(0.0, 0.0, 160.0, 32.0);
        let mut items = Vec::new();
        for (id, kind, parent) in [
            (2, ViewKind::View, ROOT_ID),
            (8, ViewKind::Modal, ROOT_ID),
            (12, ViewKind::View, 8),
        ] {
            items.push(MountItem::Create { id, kind });
            if kind == ViewKind::Modal {
                items.push(MountItem::ModalConfig {
                    id,
                    config: nsh_core::ModalConfig {
                        animation: nsh_core::ModalAnimation::None,
                        ..Default::default()
                    },
                });
            }
            items.push(MountItem::Frame { id, frame });
            items.push(MountItem::ProjectRoot {
                parent,
                id,
                following: vec![],
            });
        }
        items.extend(focus_return_input(4, 2, false));
        items.extend(focus_return_input(14, 12, false));
        items.push(MountItem::Frame { id: 14, frame });
        surface.apply(&MountBatch { items });
        assert!(crate::input::focus_view(
            &surface,
            &surface.view(14).unwrap()
        ));
        surface.apply(&MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 1,
                roots: group.clone(),
            }],
        });
        assert_eq!(surface.focus_path(), vec![14, 12, 8, ROOT_ID]);
        assert!(surface.view(2).unwrap().attached());
        assert!(surface.view(8).unwrap().attached());

        let mut items = vec![
            MountItem::Create {
                id: 16,
                kind: ViewKind::Modal,
            },
            MountItem::ModalConfig {
                id: 16,
                config: nsh_core::ModalConfig {
                    animation: nsh_core::ModalAnimation::None,
                    ..Default::default()
                },
            },
            MountItem::ProjectRoot {
                parent: ROOT_ID,
                id: 16,
                following: vec![],
            },
        ];
        items.extend(focus_return_input(18, 16, false));
        items.push(MountItem::Frame { id: 18, frame });
        surface.apply(&MountBatch { items });
        assert!(crate::input::focus_view(
            &surface,
            &surface.view(18).unwrap()
        ));
        surface.apply(&MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 2,
                roots: group.clone(),
            }],
        });
        for &id in &group {
            assert!(!surface.view(id).unwrap().attached());
        }
        assert_eq!(surface.focus_path(), vec![18, 16, ROOT_ID]);
        surface.apply(&MountBatch {
            items: vec![MountItem::ListCellRetired { roots: group }],
        });
        assert!(!surface.view(8).unwrap().attached());
        assert_eq!(surface.focus_path(), vec![18, 16, ROOT_ID]);
        surface.apply(&MountBatch {
            items: vec![
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![16],
                },
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 8,
                    following: vec![16],
                },
                MountItem::ProjectRoot {
                    parent: 8,
                    id: 12,
                    following: vec![],
                },
            ],
        });
        assert_eq!(surface.focus_path(), vec![18, 16, ROOT_ID]);
        assert_eq!(crate::navigation::focus_scope(&surface).id(), 16);
        assert!(surface.view(8).unwrap().attached());

        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 16 }],
        });
        assert!(crate::input::focus_view(
            &surface,
            &surface.view(14).unwrap()
        ));
        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 8 }],
        });
        assert!(!surface.focus_path().contains(&14));
        assert!(!surface.view(14).unwrap().attached());
    }

    #[test]
    fn projected_roots_choose_the_first_surviving_cross_cell_anchor() {
        use nsh_core::{ROOT_ID, ViewKind};

        use crate::geom::rect;
        let frame = rect(0.0, 0.0, 160.0, 32.0);
        for parked in [vec![], vec![4], vec![6], vec![4, 6]] {
            let surface = Surface::new(nsh_engine::Environment::default());
            surface.root.state_mut().frame = rect(0.0, 0.0, 400.0, 200.0);
            let mut items = Vec::new();
            for id in [2, 4, 6] {
                items.push(MountItem::Create {
                    id,
                    kind: ViewKind::View,
                });
                items.push(MountItem::Frame { id, frame });
                items.extend(focus_return_input(id + 10, id, false));
                items.push(MountItem::Frame { id: id + 10, frame });
            }
            items.extend(focus_return_input(20, ROOT_ID, false));
            items.push(MountItem::Frame { id: 20, frame });
            items.extend([
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 6,
                    following: vec![],
                },
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 4,
                    following: vec![6],
                },
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![4, 6],
                },
            ]);
            surface.apply(&MountBatch { items });
            assert!(crate::input::focus_view(
                &surface,
                &surface.view(20).unwrap()
            ));
            let mut items = vec![MountItem::RetireListCell {
                id: 2,
                request: 1,
                roots: vec![2],
            }];
            for &id in &parked {
                items.push(MountItem::RetireListCell {
                    id,
                    request: 1,
                    roots: vec![id],
                });
            }
            surface.apply(&MountBatch { items });
            surface.apply(&MountBatch {
                items: vec![MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![4, 6],
                }],
            });
            let order = |surface: &Surface| {
                surface
                    .root
                    .child_views()
                    .iter()
                    .map(|view| view.id())
                    .filter(|id| [2, 4, 6].contains(id))
                    .collect::<Vec<_>>()
            };
            let expected: Vec<_> = [2, 4, 6]
                .into_iter()
                .filter(|id| !parked.contains(id))
                .collect();
            assert_eq!(order(&surface), expected, "parked {parked:?}");
            let mut items = Vec::new();
            for &id in &parked {
                items.push(MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id,
                    following: if id == 4 { vec![6] } else { vec![] },
                });
            }
            surface.apply(&MountBatch { items });
            assert_eq!(order(&surface), vec![2, 4, 6]);

            assert!(crate::input::focus_view(
                &surface,
                &surface.view(14).unwrap()
            ));
            surface.apply(&MountBatch {
                items: vec![
                    MountItem::RetireListCell {
                        id: 2,
                        request: 2,
                        roots: vec![2],
                    },
                    MountItem::RetireListCell {
                        id: 4,
                        request: 2,
                        roots: vec![4],
                    },
                ],
            });
            assert_eq!(surface.focus_path(), vec![14, 4, ROOT_ID]);
            assert_eq!(order(&surface), vec![4, 6]);
            surface.apply(&MountBatch {
                items: vec![MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![4, 6],
                }],
            });
            assert_eq!(order(&surface), vec![2, 4, 6]);
            assert_eq!(surface.focus_path(), vec![14, 4, ROOT_ID]);
        }
    }

    #[test]
    fn source_scroll_stop_reuses_the_registered_driver_until_the_surface_ticks() {
        use nsh_core::{ROOT_ID, ViewKind};

        use crate::geom::rect;
        let surface = Surface::new(nsh_engine::Environment::default());
        surface.root.state_mut().frame = rect(0.0, 0.0, 300.0, 400.0);
        surface.apply(&MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::View,
                },
                MountItem::Frame {
                    id: 2,
                    frame: rect(0.0, 0.0, 300.0, 400.0),
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Create {
                    id: 4,
                    kind: ViewKind::Scroll,
                },
                MountItem::Frame {
                    id: 4,
                    frame: rect(0.0, 0.0, 300.0, 400.0),
                },
                MountItem::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
                MountItem::ScrollContent {
                    id: 4,
                    size: nsh_core::Size::new(Points(300.0), Points(2000.0)),
                },
            ],
        });
        let idle_clients = surface.frame_clients.borrow().len();
        let scroll_to = |y, animated| MountItem::Command {
            id: 4,
            command: nsh_core::Command::ScrollTo {
                x: Points(0.0),
                y: Points(y),
                animated,
            },
        };
        surface.apply(&MountBatch {
            items: vec![scroll_to(200.0, true)],
        });
        let moving_clients = surface.frame_clients.borrow().len();
        assert!(moving_clients > idle_clients);
        for y in [240.0, 280.0, 320.0] {
            surface.apply(&MountBatch {
                items: vec![
                    MountItem::Remove { id: 2 },
                    MountItem::Insert {
                        parent: ROOT_ID,
                        child: 2,
                        before: None,
                    },
                    scroll_to(y, true),
                ],
            });
            // These are the actual queued native frame tasks. A stop may
            // not register another driver before the previous task runs.
            assert_eq!(surface.frame_clients.borrow().len(), moving_clients);
        }
        surface.tick();
        let scroll = surface.view(4).unwrap();
        let stopped = scroll.state().scroll.as_ref().unwrap().y;
        surface.apply(&MountBatch {
            items: vec![
                MountItem::Remove { id: 2 },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        });
        surface.tick();
        assert_eq!(scroll.state().scroll.as_ref().unwrap().y, stopped);
        assert_eq!(surface.frame_clients.borrow().len(), idle_clients);

        surface.apply(&MountBatch {
            items: vec![scroll_to(400.0, false)],
        });
        surface.tick();
        assert_eq!(scroll.state().scroll.as_ref().unwrap().y, Points(400.0));
        assert_eq!(surface.frame_clients.borrow().len(), idle_clients);
    }

    #[test]
    fn new_tracking_reports_existing_native_focus_and_hover_then_tracks_departure() {
        use nsh_core::{ViewKind, tailwind::state};

        use crate::geom::rect;
        let surface = Surface::new(nsh_engine::Environment::default());
        surface.root.state_mut().frame = rect(0.0, 0.0, 400.0, 400.0);
        let mut items = vec![
            MountItem::Create {
                id: 2,
                kind: ViewKind::Scroll,
            },
            MountItem::Frame {
                id: 2,
                frame: rect(0.0, 0.0, 200.0, 200.0),
            },
            MountItem::Insert {
                parent: nsh_core::ROOT_ID,
                child: 2,
                before: None,
            },
        ];
        items.extend(focus_return_input(4, 2, false));
        items.extend(focus_return_input(6, 2, false));
        items.extend(focus_return_input(8, nsh_core::ROOT_ID, false));
        for (id, x, y) in [(4, 0.0, 0.0), (6, 0.0, 40.0), (8, 240.0, 0.0)] {
            items.push(MountItem::Frame {
                id,
                frame: rect(x, y, 100.0, 32.0),
            });
        }
        surface.apply(&MountBatch { items });
        let mark = surface.view(4).unwrap();
        crate::text_input::focus_view(&surface, &mark);
        let move_to = |x| {
            crate::input::pointer(
                &surface,
                crate::input::PointerEvent {
                    kind: crate::input::PointerKind::Move,
                    x,
                    y: 20.0,
                    button: 0,
                    pointer: 1,
                    touch: false,
                    pen: false,
                    time: 1.0,
                    modifiers: Default::default(),
                    clicks: 0,
                },
            )
        };
        move_to(20.0);
        surface.apply(&MountBatch {
            items: vec![
                MountItem::TrackStates {
                    id: 2,
                    states: state::HOVERED | state::FOCUS_WITHIN,
                },
                MountItem::TrackStates {
                    id: 4,
                    states: state::FOCUSED,
                },
            ],
        });
        // Real Surface::drain re-picks hover after the completed batch.
        crate::input::rehover(&surface);
        let rail = surface.view(2).unwrap();
        assert_eq!(rail.state().states, state::HOVERED | state::FOCUS_WITHIN);
        assert_eq!(mark.state().states, state::FOCUSED);
        crate::text_input::focus_view(&surface, &surface.view(6).unwrap());
        assert_eq!(rail.state().states, state::HOVERED | state::FOCUS_WITHIN);
        crate::text_input::focus_view(&surface, &surface.view(8).unwrap());
        assert_eq!(rail.state().states, state::HOVERED);
        move_to(300.0);
        assert_eq!(rail.state().states, 0);
        // Virtualization can recycle a focused row without a focus command.
        crate::text_input::focus_view(&surface, &surface.view(6).unwrap());
        assert_eq!(rail.state().states, state::FOCUS_WITHIN);
        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 6 }, MountItem::Delete { id: 6 }],
        });
        assert_eq!(rail.state().states, 0);
    }

    fn focus_return_popup(id: NodeId, parent: NodeId) -> Vec<MountItem> {
        vec![
            MountItem::Create {
                id,
                kind: nsh_core::ViewKind::View,
            },
            // Nested logical popups have native sibling views.
            MountItem::Insert {
                parent: ROOT_ID,
                child: id,
                before: None,
            },
            MountItem::ViewProps {
                id,
                props: Box::new(nsh_core::ViewProps {
                    focus_return_parent: Some(parent),
                    ..Default::default()
                }),
            },
        ]
    }

    fn focus_return_form() -> Rc<Surface> {
        let surface = Surface::new(nsh_engine::Environment::default());
        surface.root.state_mut().frame = crate::geom::rect(0.0, 0.0, 400.0, 400.0);
        surface.apply(&MountBatch {
            items: focus_return_input(2, ROOT_ID, true),
        });
        crate::text_input::set_selection(&surface.view(2).unwrap(), 2, 2);
        surface
    }

    fn focused_id(surface: &Surface) -> Option<NodeId> {
        crate::text_input::focused_view(surface).map(|view| view.id())
    }

    fn focus_return_modal(id: NodeId, field: NodeId) -> Vec<MountItem> {
        let mut items = vec![
            MountItem::Create {
                id,
                kind: nsh_core::ViewKind::Modal,
            },
            MountItem::ModalConfig {
                id,
                config: nsh_core::ModalConfig {
                    animation: nsh_core::ModalAnimation::None,
                    ..Default::default()
                },
            },
            MountItem::Insert {
                parent: ROOT_ID,
                child: id,
                before: None,
            },
        ];
        items.extend(focus_return_input(field, id, true));
        items.push(MountItem::Command {
            id: field,
            command: nsh_core::Command::Focus,
        });
        items
    }

    #[test]
    fn replacing_popups_and_modals_keeps_the_original_opener_and_caret() {
        for back in [false, true] {
            for insert_first in [false, true] {
                let surface = focus_return_form();
                let original = surface.view(2).unwrap();
                let mut items = focus_return_input(4, ROOT_ID, false);
                items.push(MountItem::Insert {
                    parent: ROOT_ID,
                    child: 4,
                    before: Some(2),
                });
                items.extend(focus_return_popup(10, ROOT_ID));
                items.extend(focus_return_input(12, 10, false));
                surface.apply(&MountBatch { items });
                assert_eq!(focused_id(&surface), Some(12));

                let remove = vec![MountItem::Delete { id: 12 }, MountItem::Delete { id: 10 }];
                let modal = focus_return_modal(30, 32);
                let items = if insert_first {
                    modal.into_iter().chain(remove).collect()
                } else {
                    remove.into_iter().chain(modal).collect()
                };
                surface.apply(&MountBatch { items });
                assert_eq!(focused_id(&surface), Some(32));

                let remove = vec![MountItem::Delete { id: 32 }, MountItem::Delete { id: 30 }];
                if back {
                    let mut popup = focus_return_popup(40, ROOT_ID);
                    popup.extend(focus_return_input(42, 40, false));
                    let items = if insert_first {
                        popup.into_iter().chain(remove).collect()
                    } else {
                        remove.into_iter().chain(popup).collect()
                    };
                    surface.apply(&MountBatch { items });
                    assert_eq!(focused_id(&surface), Some(42));
                    surface.apply(&MountBatch {
                        items: vec![MountItem::Delete { id: 42 }, MountItem::Delete { id: 40 }],
                    });
                } else {
                    surface.apply(&MountBatch { items: remove });
                }
                assert_eq!(surface.view(2), Some(original));
                assert_eq!(focused_id(&surface), Some(2));
                assert_eq!(
                    crate::text_input::ime::selected_text_range(&surface)
                        .unwrap()
                        .range,
                    2..2
                );
            }
        }
    }

    #[test]
    fn a_modal_inherits_a_removed_popup_owner_without_overriding_new_focus() {
        for recreate_opener in [None, Some(false), Some(true)] {
            let surface = focus_return_form();
            let mut items = focus_return_popup(10, ROOT_ID);
            items.extend(focus_return_input(12, 10, false));
            surface.apply(&MountBatch { items });
            surface.apply(&MountBatch {
                items: focus_return_modal(30, 32),
            });
            assert_eq!(focused_id(&surface), Some(32));
            // Retire the covered popup in a later batch, while its modal
            // still owns focus. Reusing the old opener id is a new view.
            let mut items = vec![MountItem::Delete { id: 12 }, MountItem::Delete { id: 10 }];
            if let Some(recreate) = recreate_opener {
                if recreate {
                    items.push(MountItem::Delete { id: 2 });
                    items.extend(focus_return_input(2, ROOT_ID, false));
                } else {
                    items.push(MountItem::Remove { id: 2 });
                    items.push(MountItem::Insert {
                        parent: ROOT_ID,
                        child: 2,
                        before: None,
                    });
                }
            } else {
                // Insert-only movement preserves the original return target.
                items.push(MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                });
            }
            surface.apply(&MountBatch { items });
            assert_eq!(focused_id(&surface), Some(32));
            assert!(crate::navigation::go_back(&surface));
            assert_eq!(
                focused_id(&surface),
                if recreate_opener.is_some() {
                    None
                } else {
                    Some(2)
                }
            );
        }

        let surface = focus_return_form();
        let mut items = focus_return_input(4, ROOT_ID, false);
        items.extend(focus_return_modal(30, 32));
        surface.apply(&MountBatch { items });
        let mut items = vec![MountItem::Delete { id: 32 }, MountItem::Delete { id: 30 }];
        items.extend(focus_return_popup(40, ROOT_ID));
        items.extend(focus_return_input(42, 40, false));
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(42));
        surface.apply(&MountBatch {
            items: vec![
                MountItem::Command {
                    id: 4,
                    command: nsh_core::Command::Focus,
                },
                MountItem::Delete { id: 42 },
                MountItem::Delete { id: 40 },
            ],
        });
        assert_eq!(focused_id(&surface), Some(4));
    }

    #[test]
    fn closing_a_replacement_modal_keeps_an_explicit_blur() {
        for blur_first in [false, true] {
            let surface = focus_return_form();
            let mut items = focus_return_popup(10, ROOT_ID);
            items.extend(focus_return_input(12, 10, false));
            surface.apply(&MountBatch { items });
            let mut items = vec![MountItem::Delete { id: 12 }, MountItem::Delete { id: 10 }];
            items.extend(focus_return_modal(30, 32));
            surface.apply(&MountBatch { items });
            assert_eq!(focused_id(&surface), Some(32));
            let blur = MountItem::Command {
                id: 32,
                command: nsh_core::Command::Blur,
            };
            let mut items = vec![MountItem::Delete { id: 32 }, MountItem::Delete { id: 30 }];
            if blur_first {
                items.insert(0, blur);
            } else {
                items.push(blur);
            }
            surface.apply(&MountBatch { items });
            assert_eq!(focused_id(&surface), None);
        }
    }

    #[test]
    fn a_popup_returns_to_the_keyboard_opener_with_its_caret() {
        let surface = focus_return_form();
        let mut items = focus_return_popup(10, ROOT_ID);
        items.extend(focus_return_input(12, 10, true));
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(12));
        surface.apply(&MountBatch {
            items: vec![
                MountItem::Remove { id: 10 },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 10,
                    before: None,
                },
            ],
        });
        assert_eq!(focused_id(&surface), Some(12));
        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        assert_eq!(focused_id(&surface), Some(2));
        assert_eq!(
            crate::text_input::ime::selected_text_range(&surface)
                .unwrap()
                .range,
            2..2
        );

        // Showing the retained overlay again need not resend ViewProps.
        surface.apply(&MountBatch {
            items: vec![MountItem::Insert {
                parent: ROOT_ID,
                child: 10,
                before: None,
            }],
        });
        assert_eq!(focused_id(&surface), Some(12));
        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        assert_eq!(focused_id(&surface), Some(2));
        assert_eq!(
            crate::text_input::ime::selected_text_range(&surface)
                .unwrap()
                .range,
            2..2
        );
    }

    #[test]
    fn a_pointer_opened_popup_returns_to_its_actual_trigger() {
        let surface = focus_return_form();
        let mut events = nsh_core::EventMask::default();
        events.set(EventKind::Press, true);
        surface.apply(&MountBatch {
            items: vec![
                MountItem::Create {
                    id: 4,
                    kind: nsh_core::ViewKind::View,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 4,
                    before: None,
                },
                MountItem::Frame {
                    id: 4,
                    frame: crate::geom::rect(100.0, 0.0, 100.0, 30.0),
                },
                MountItem::Events { id: 4, events },
            ],
        });
        for kind in [
            crate::input::PointerKind::Down,
            crate::input::PointerKind::Up,
        ] {
            crate::input::pointer(
                &surface,
                crate::input::PointerEvent {
                    kind,
                    x: 110.0,
                    y: 10.0,
                    button: 0,
                    pointer: 1,
                    touch: false,
                    pen: false,
                    time: 1.0,
                    modifiers: Default::default(),
                    clicks: 1,
                },
            );
        }
        assert_eq!(focused_id(&surface), Some(4));
        let mut items = focus_return_popup(10, ROOT_ID);
        items.extend(focus_return_input(12, 10, true));
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(12));
        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        assert_eq!(focused_id(&surface), Some(4));

        let mut pending = focus_return_input(44, ROOT_ID, true);
        let _ = pending.pop(); // Configured now, inserted by a later batch.
        surface.apply(&MountBatch { items: pending });
        crate::input::focus_view(&surface, &surface.view(4).unwrap());
        surface.apply(&MountBatch {
            items: vec![MountItem::Insert {
                parent: ROOT_ID,
                child: 44,
                before: None,
            }],
        });
        assert_eq!(focused_id(&surface), Some(4));
    }

    #[test]
    fn popup_focus_survives_relocation_and_respects_new_outside_focus() {
        let surface = focus_return_form();
        let mut items = focus_return_popup(10, ROOT_ID);
        items.extend(focus_return_input(12, 10, false));
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(12));
        crate::text_input::set_selection(&surface.view(12).unwrap(), 3, 3);
        surface.apply(&MountBatch {
            items: vec![
                MountItem::Remove { id: 10 },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 10,
                    before: None,
                },
            ],
        });
        assert_eq!(focused_id(&surface), Some(12));
        assert_eq!(
            crate::text_input::ime::selected_text_range(&surface)
                .unwrap()
                .range,
            3..3
        );

        // An explicit new owner, like the native focus established by an
        // outside pointer Down, wins over the popup's later close batch.
        surface.apply(&MountBatch {
            items: focus_return_input(4, ROOT_ID, false),
        });
        crate::input::focus_view(&surface, &surface.view(4).unwrap());
        surface.apply(&MountBatch {
            items: vec![MountItem::Delete { id: 10 }],
        });
        assert_eq!(focused_id(&surface), Some(4));

        let mut items = focus_return_popup(20, ROOT_ID);
        items.extend(focus_return_input(22, 20, false));
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(22));
        surface.apply(&MountBatch {
            items: vec![
                MountItem::Command {
                    id: 22,
                    command: nsh_core::Command::Blur,
                },
                MountItem::Remove { id: 20 },
            ],
        });
        assert_eq!(focused_id(&surface), None);
    }

    #[test]
    fn nested_native_siblings_unwind_after_their_owners_are_deleted() {
        let surface = focus_return_form();
        let mut items = focus_return_popup(10, ROOT_ID);
        items.extend(focus_return_input(12, 10, false));
        items.extend(focus_return_popup(20, 10));
        items.extend(focus_return_input(22, 20, true));
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(22));
        assert_eq!(
            surface.view(20).unwrap().parent_view(),
            Some(surface.root.clone())
        );
        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 20 }],
        });
        assert_eq!(focused_id(&surface), Some(12));
        surface.apply(&MountBatch {
            items: vec![MountItem::Insert {
                parent: ROOT_ID,
                child: 20,
                before: None,
            }],
        });
        assert_eq!(focused_id(&surface), Some(22));
        surface.apply(&MountBatch {
            items: vec![
                MountItem::Delete { id: 12 },
                MountItem::Delete { id: 10 },
                MountItem::Delete { id: 22 },
                MountItem::Delete { id: 20 },
            ],
        });
        assert_eq!(focused_id(&surface), Some(2));
        assert_eq!(
            crate::text_input::ime::selected_text_range(&surface)
                .unwrap()
                .range,
            2..2
        );
    }

    #[test]
    fn replacing_a_popup_and_reusing_an_opener_id_do_not_restore_stale_views() {
        for recreate in [false, true] {
            let surface = focus_return_form();
            let mut items = focus_return_popup(10, ROOT_ID);
            items.extend(focus_return_input(12, 10, false));
            surface.apply(&MountBatch { items });
            let mut items = vec![MountItem::Delete { id: 12 }, MountItem::Delete { id: 10 }];
            items.extend(focus_return_popup(20, ROOT_ID));
            items.extend(focus_return_input(22, 20, false));
            surface.apply(&MountBatch { items });
            assert_eq!(focused_id(&surface), Some(22));
            surface.apply(&MountBatch {
                items: vec![MountItem::Delete { id: 20 }],
            });
            assert_eq!(focused_id(&surface), Some(2));

            // A list cell can retire while its retained input survives.
            // Moving the input into that cell does not itself retire focus.
            surface.apply(&MountBatch {
                items: vec![
                    MountItem::Create {
                        id: 4,
                        kind: nsh_core::ViewKind::View,
                    },
                    MountItem::Insert {
                        parent: ROOT_ID,
                        child: 4,
                        before: None,
                    },
                    MountItem::Insert {
                        parent: 4,
                        child: 2,
                        before: None,
                    },
                ],
            });
            assert_eq!(focused_id(&surface), Some(2));
            assert_eq!(
                crate::text_input::ime::selected_text_range(&surface)
                    .unwrap()
                    .range,
                2..2
            );
            let mut items = focus_return_popup(30, ROOT_ID);
            items.extend(focus_return_input(32, 30, false));
            surface.apply(&MountBatch { items });
            let original = surface.view(2).unwrap();
            let items = if recreate {
                let mut items = vec![MountItem::Delete { id: 2 }];
                items.extend(focus_return_input(2, ROOT_ID, false));
                items
            } else {
                vec![
                    MountItem::Remove { id: 4 },
                    MountItem::Insert {
                        parent: ROOT_ID,
                        child: 4,
                        before: None,
                    },
                ]
            };
            surface.apply(&MountBatch { items });
            assert_eq!(surface.view(2).as_ref() == Some(&original), !recreate);
            surface.apply(&MountBatch {
                items: vec![MountItem::Delete { id: 30 }],
            });
            assert_eq!(focused_id(&surface), None);

            // Capture before this batch sees the old opener. Removing and
            // reinserting it before opening another popup cannot refresh that
            // saved target into authority over the replacement row.
            crate::input::focus_view(&surface, &surface.view(2).unwrap());
            let mut items = vec![
                MountItem::Remove { id: 2 },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ];
            items.extend(focus_return_popup(40, ROOT_ID));
            items.extend(focus_return_input(42, 40, false));
            surface.apply(&MountBatch { items });
            assert_eq!(focused_id(&surface), Some(42));
            surface.apply(&MountBatch {
                items: vec![MountItem::Delete { id: 40 }],
            });
            assert_eq!(focused_id(&surface), None);
        }
    }

    #[test]
    fn popup_tab_stops_and_explicit_focus_commands_keep_their_native_authority() {
        let surface = focus_return_form();
        let mut press = nsh_core::EventMask::default();
        press.set(EventKind::Press, true);
        let mut items = focus_return_popup(10, ROOT_ID);
        for id in [12, 14, 16] {
            items.extend([
                MountItem::Create {
                    id,
                    kind: nsh_core::ViewKind::View,
                },
                MountItem::Insert {
                    parent: 10,
                    child: id,
                    before: None,
                },
                MountItem::Events { id, events: press },
            ]);
        }
        items.push(MountItem::ViewProps {
            id: 12,
            props: Box::new(nsh_core::ViewProps {
                focusable: Some(false),
                ..Default::default()
            }),
        });
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(14));
        let tab = crate::input::KeyEvent {
            vk: crate::keys::VK_TAB,
            down: true,
            repeat: false,
            modifiers: Default::default(),
        };
        assert!(crate::input::key(&surface, tab));
        assert_eq!(focused_id(&surface), Some(16));
        assert!(crate::input::key(&surface, tab));
        assert_eq!(focused_id(&surface), Some(14));
        assert!(crate::input::tab_to_edge(&surface, true));
        assert_eq!(focused_id(&surface), Some(16));
        assert!(crate::input::tab_to_edge(&surface, false));
        assert_eq!(focused_id(&surface), Some(14));

        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        let mut items = focus_return_popup(20, ROOT_ID);
        items.extend(focus_return_input(22, 20, true));
        items.push(MountItem::Command {
            id: 2,
            command: nsh_core::Command::Focus,
        });
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(2));
        assert_eq!(crate::focus_return::scope(&surface), None);
    }

    #[test]
    fn a_modal_temporarily_covering_a_popup_keeps_its_return_owner() {
        let surface = focus_return_form();
        let mut items = focus_return_popup(10, ROOT_ID);
        items.extend(focus_return_input(12, 10, false));
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(12));

        let mut items = vec![
            MountItem::Create {
                id: 30,
                kind: nsh_core::ViewKind::Modal,
            },
            MountItem::ModalConfig {
                id: 30,
                config: nsh_core::ModalConfig {
                    animation: nsh_core::ModalAnimation::None,
                    ..Default::default()
                },
            },
            MountItem::Insert {
                parent: ROOT_ID,
                child: 30,
                before: None,
            },
        ];
        items.extend(focus_return_input(32, 30, false));
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(32));
        assert_eq!(crate::focus_return::scope(&surface), None);

        // A popup in a modal names that actual modal as its root owner.
        let mut items = focus_return_popup(40, 30);
        items[1] = MountItem::Insert {
            parent: 30,
            child: 40,
            before: None,
        };
        items.extend(focus_return_input(42, 40, false));
        surface.apply(&MountBatch { items });
        assert_eq!(focused_id(&surface), Some(42));
        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 40 }],
        });
        assert_eq!(focused_id(&surface), Some(32));

        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 30 }],
        });
        assert_eq!(focused_id(&surface), Some(12));
        assert_eq!(crate::focus_return::scope(&surface), surface.view(10));
        surface.apply(&MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        assert_eq!(focused_id(&surface), Some(2));
        assert_eq!(
            crate::text_input::ime::selected_text_range(&surface)
                .unwrap()
                .range,
            2..2
        );
    }

    fn error(text: &str) -> AppError {
        AppError::new(nsh_engine::AppErrorKind::Uncaught, text)
    }

    /// A surface draining `messages` as if an engine had sent them.
    fn sent(surface: &Surface, messages: Vec<Message>) {
        let (tx, rx) = crossbeam_channel::unbounded();
        for m in messages {
            tx.send(m).unwrap();
        }
        *surface.rx.borrow_mut() = Some(rx);
    }

    #[test]
    fn the_hosts_locale_and_text_size_stand_in_for_the_systems() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let zh = nsh_engine::Locale::parse("zh-Hans-CN");
        surface
            .host_environment
            .set(nsh_core::platform::HostEnvironment {
                locale: zh,
                font_scale: Some(1.5),
            });
        // What the system reports goes under the host's settings.
        surface.set_environment(nsh_engine::Environment {
            font_scale: 1.25,
            ..Default::default()
        });
        let env = surface.environment.get();
        assert_eq!((Some(env.locale), env.font_scale), (zh, 1.5));
        surface.host_environment.set(Default::default());
        surface.set_environment(nsh_engine::Environment {
            font_scale: 1.25,
            ..Default::default()
        });
        let env = surface.environment.get();
        assert_eq!(
            (env.locale, env.font_scale),
            (nsh_engine::Locale::EN_US, 1.25)
        );
    }

    #[test]
    fn an_error_handler_restarting_the_app_drops_the_old_engines_messages() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let weak = Rc::downgrade(&surface);
        surface.set_error_handler(Box::new(move |_| {
            let surface = weak.upgrade().unwrap();
            // What a restart does first; setting a handler again must not
            // find it borrowed.
            surface.stop();
            surface.set_error_handler(Box::new(|_| {}));
        }));
        sent(
            &surface,
            vec![
                Message::Error(error("boom")),
                Message::Batch(MountBatch::default()),
            ],
        );
        surface.drain();
        assert_eq!(surface.batches.get(), 0);
    }

    #[test]
    fn messages_apply_in_order_without_a_restart() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let errors = Rc::new(Cell::new(0));
        let seen = errors.clone();
        surface.set_error_handler(Box::new(move |_| seen.set(seen.get() + 1)));
        sent(
            &surface,
            vec![
                Message::Error(error("first")),
                Message::Batch(MountBatch::default()),
                Message::Error(error("second")),
            ],
        );
        surface.drain();
        assert_eq!((errors.get(), surface.batches.get()), (2, 1));
    }

    #[cfg(feature = "dev")]
    #[test]
    fn a_dev_session_hears_errors_besides_the_embedding_apps_handler() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let heard = Rc::new(RefCell::new(Vec::new()));
        let host = heard.clone();
        surface.set_error_handler(Box::new(move |m| {
            host.borrow_mut().push(format!("host {m}"))
        }));
        let dev = heard.clone();
        surface.set_dev_error_handler(Box::new(move |m| dev.borrow_mut().push(format!("dev {m}"))));
        sent(&surface, vec![Message::Error(error("boom"))]);
        surface.drain();
        assert_eq!(*heard.borrow(), ["dev boom", "host boom"]);
    }

    #[test]
    fn the_error_handler_hears_what_went_wrong_and_the_package() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let heard = Rc::new(RefCell::new(Vec::new()));
        let seen = heard.clone();
        surface.set_error_handler(Box::new(move |e| seen.borrow_mut().push(e.clone())));
        let package = std::sync::Arc::new(nsh_engine::PackageInfo {
            id: "com.example.app".into(),
            name: "App".into(),
            version: "1.0.0".into(),
            build: 7,
            sha256: "0".repeat(64),
        });
        let stopped = AppError::new(nsh_engine::AppErrorKind::Stopped, "out of memory")
            .with_package(Some(package));
        sent(&surface, vec![Message::Error(stopped.clone())]);
        surface.drain();
        let heard = heard.borrow();
        assert_eq!(*heard, [stopped]);
        assert!(heard[0].is_fatal());
        assert_eq!(heard[0].package.as_ref().map(|p| p.build), Some(7));
    }
}
