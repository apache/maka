//! One surface: an engine thread and the views it mounts on the GTK main
//! thread.
//!
//! The engine thread hands each commit to [`Sink`], which queues it and
//! wakes the main loop once (`MainContext::invoke`); the main thread
//! drains the queue and applies every batch in order ([`Surface::drain`]).
//! Native animations and JS frame requests run on the root view's frame
//! clock (`add_tick_callback`) while there is something to do.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crossbeam_channel::{Receiver, Sender};
use gtk4::{self as gtk, glib, prelude::*};
use nsh_core::{EventKind, EventPayload, MountBatch, MountItem, NodeId, Points, ROOT_ID, Size};
use nsh_engine::{Engine, EngineConfig, EngineControl, Environment, MountSink};
use rustc_hash::FxHashMap;

use crate::{animation::UiAnimation, mount::Mounter, text::PangoTextEngine, view::NshView};

/// What the engine thread sends the main thread.
enum Message {
    Batch(MountBatch),
    Error(String),
    Frame,
    HotUpdateFailed,
}

thread_local! {
    /// The surfaces of this (main) thread, by key: the sink wakes one by
    /// its key, as `invoke` closures must be `Send`.
    static SURFACES: RefCell<FxHashMap<u64, Weak<Surface>>> = RefCell::default();
}

static NEXT_KEY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Forwards batches from the engine thread to the main thread.
struct Sink {
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
            glib::MainContext::default().invoke(move || {
                let surface = SURFACES.with(|s| s.borrow().get(&key).and_then(Weak::upgrade));
                if let Some(surface) = surface {
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

/// Called when the app reports a fatal error (development hosts show it).
pub(crate) type ErrorHandler = Box<dyn Fn(&str)>;

/// One engine and its views.
pub(crate) struct Surface {
    key: u64,
    /// The root view (node [`ROOT_ID`]): the surface's widget.
    pub(crate) root: NshView,
    /// Views by node id, and what mounting needs between items.
    pub(crate) mounter: RefCell<Mounter>,
    /// The native animation graph.
    pub(crate) anim: RefCell<UiAnimation>,
    /// Stacks, screens and modals.
    pub(crate) nav: RefCell<crate::navigation::Nav>,
    /// Pointer input state ([`crate::input`]).
    pub(crate) input: crate::input::Input,
    pub(crate) file_drop: crate::file_drop::State,
    engine: RefCell<Option<Engine>>,
    control: RefCell<Option<EngineControl>>,
    rx: RefCell<Option<Receiver<Message>>>,
    pending: RefCell<Arc<AtomicBool>>,
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
    /// The tick callback runs.
    ticking: Cell<bool>,
    on_error: RefCell<Option<ErrorHandler>>,
    on_hot_update_failed: RefCell<Option<Box<dyn Fn()>>>,
    /// The model of a test session's app (`nsh test --target linux`).
    #[cfg(feature = "dev")]
    test_model: RefCell<Option<Arc<nsh_testing::agent::Model>>>,
    /// Where `asset:/` image URIs resolve ([`crate::image::set_asset_base`]).
    pub(crate) asset_base: RefCell<Option<crate::image::AssetBase>>,
    /// The disk cache of downloaded images ([`crate::image::set_disk_cache`]).
    pub(crate) image_cache: RefCell<Option<nsh_core::image::DiskCache>>,
    /// What the running app may reach (checked for image redirects).
    pub(crate) access: RefCell<Arc<nsh_core::access::Access>>,
    /// Videos, web views and registered native components.
    pub(crate) native: crate::native::NativeState,
    /// The app's keyboard shortcuts ([`crate::keymap`]).
    pub(crate) keymap: crate::keymap::KeymapState,
    /// The window's chrome: title bar, menus ([`crate::chrome`]).
    pub(crate) chrome: crate::chrome::Chrome,
    /// Selections across the texts of selection areas
    /// ([`crate::selection_area`]).
    pub(crate) selection: crate::selection_area::State,
    /// The performance monitor, while it measures ([`crate::fps`]).
    fps: RefCell<Option<Rc<crate::fps::Fps>>>,
}

impl Surface {
    /// A surface with no app yet.
    pub(crate) fn new(environment: Environment) -> Rc<Surface> {
        let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
        let root = NshView::new(ROOT_ID, nsh_core::ViewKind::View);
        root.set_hexpand(true);
        root.set_vexpand(true);
        let surface = Rc::new(Surface {
            key,
            root: root.clone(),
            mounter: RefCell::new(Mounter::new(root.clone())),
            anim: RefCell::new(UiAnimation::default()),
            nav: RefCell::default(),
            input: Default::default(),
            file_drop: Default::default(),
            engine: RefCell::new(None),
            control: RefCell::new(None),
            rx: RefCell::new(None),
            pending: RefCell::new(Arc::new(AtomicBool::new(false))),
            environment: Cell::new(environment),
            appearance: Cell::default(),
            host_environment: Cell::default(),
            host_tokens: RefCell::new(None),
            js_frame: Cell::new(false),
            ticking: Cell::new(false),
            on_error: RefCell::new(None),
            on_hot_update_failed: RefCell::new(None),
            #[cfg(feature = "dev")]
            test_model: RefCell::default(),
            asset_base: RefCell::new(None),
            image_cache: RefCell::new(None),
            access: RefCell::new(Arc::default()),
            native: Default::default(),
            keymap: Default::default(),
            chrome: Default::default(),
            selection: Default::default(),
            fps: RefCell::new(None),
        });
        SURFACES.with(|s| s.borrow_mut().insert(key, Rc::downgrade(&surface)));
        let weak = Rc::downgrade(&surface);
        root.on_resize(move |width, height| {
            if let Some(surface) = weak.upgrade() {
                surface.resized(width, height);
            }
        });
        // Canvases that came into sight are drawn in the frame that shows them.
        root.connect_realize(|root| {
            if let Some(clock) = root.frame_clock() {
                clock.connect_layout(|_| crate::canvas::reveal());
            }
        });
        crate::input::install(&surface);
        crate::scroll::install_keyboard(&surface);
        surface
    }

    /// Measures the surface's frames and commits and logs them once a
    /// second ([`crate::fps`]).
    pub(crate) fn enable_fps(&self) {
        if self.fps.borrow().is_some() {
            return;
        }
        let fps = Rc::new(crate::fps::Fps::new());
        crate::fps::install(self.root.upcast_ref(), &fps);
        self.control(|c| c.set_perf_monitor(Some(fps.monitor.clone())));
        *self.fps.borrow_mut() = Some(fps);
    }

    /// Its key ([`Surface::by_key`]).
    #[cfg(feature = "dev")]
    pub(crate) fn key(&self) -> u64 {
        self.key
    }

    /// The surface `key` names, while it exists.
    #[cfg(feature = "dev")]
    pub(crate) fn by_key(key: u64) -> Option<Rc<Surface>> {
        SURFACES.with(|s| s.borrow().get(&key).and_then(Weak::upgrade))
    }

    /// Whether a native animation runs: the graph's, or a navigation
    /// transition.
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.anim.borrow().animating()
            || self
                .nav
                .try_borrow()
                .map_or(true, |nav| nav.transitioning())
    }

    /// Keeps the model `nsh test --target` steps see of the app
    /// ([`nsh_testing::agent::Model`]): every batch applied and every error
    /// go to it from now on.
    #[cfg(feature = "dev")]
    pub(crate) fn set_test_model(&self, model: Option<Arc<nsh_testing::agent::Model>>) {
        *self.test_model.borrow_mut() = model;
    }

    /// Starts `config`'s app, replacing what ran.
    pub(crate) fn start(self: &Rc<Self>, mut config: EngineConfig) {
        self.stop();
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
        let family = crate::text::ui_family();
        // The embedding app's theme overrides are in the first frame.
        let tokens = self.host_tokens.borrow().clone();
        let setup = |control: &EngineControl| {
            if tokens.is_some() {
                control.set_tokens(tokens);
            }
        };
        match Engine::start_with(config, move || PangoTextEngine::new(family), sink, setup) {
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
        crate::selection_area::reset(self);
        crate::keymap::clear(self);
        self.js_frame.set(false);
    }

    /// Calls `f` with the engine's control, if an app runs.
    pub(crate) fn control(&self, f: impl FnOnce(&EngineControl)) {
        if let Some(control) = &*self.control.borrow() {
            f(control);
        }
    }

    /// Sends an event to JS.
    pub(crate) fn event(&self, id: NodeId, kind: EventKind, payload: EventPayload) {
        self.control(|c| c.dispatch_event(id, kind, payload));
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

    fn resized(&self, width: f32, height: f32) {
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
    }

    /// Applies what the engine sent.
    fn drain(self: &Rc<Self>) {
        let started = self
            .fps
            .borrow()
            .is_some()
            .then(nsh_core::time::Instant::now);
        self.drain_messages();
        if let (Some(started), Some(fps)) = (started, &*self.fps.borrow()) {
            fps.drained(started.elapsed());
        }
    }

    fn drain_messages(self: &Rc<Self>) {
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
                        model.error(message.clone());
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
        let finished = {
            let mut anim = self.anim.borrow_mut();
            anim.write(&self.mounter.borrow());
            std::mem::take(&mut anim.finished)
        };
        crate::scroll::pin_animated_sticky(self);
        if !finished.is_empty() {
            self.control(|c| c.animations_finished(finished));
        }
    }

    /// Runs the tick callback while animations run or JS wants a frame.
    pub(crate) fn ensure_ticking(self: &Rc<Self>) {
        if self.ticking.get() || !(self.js_frame.get() || self.anim.borrow().animating()) {
            return;
        }
        self.ticking.set(true);
        let weak = Rc::downgrade(self);
        self.root.add_tick_callback(move |_, clock| {
            let Some(surface) = weak.upgrade() else {
                return glib::ControlFlow::Break;
            };
            // GDK frame times are microseconds; the animation graph runs on seconds.
            let now = clock.frame_time() as f64 / 1_000_000.0;
            surface.tick(now);
            if surface.js_frame.get() || surface.anim.borrow().animating() {
                glib::ControlFlow::Continue
            } else {
                surface.ticking.set(false);
                glib::ControlFlow::Break
            }
        });
    }

    fn tick(&self, now: f64) {
        if self.anim.borrow().animating() {
            self.anim.borrow_mut().tick(now);
            self.write_animations();
        }
        if self.js_frame.replace(false) {
            self.control(|c| c.frame());
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        let key = self.key;
        let _ = SURFACES.try_with(|s| s.borrow_mut().remove(&key));
    }
}

/// The widget type a surface is shown in.
pub(crate) fn widget(surface: &Surface) -> gtk::Widget {
    surface.root.clone().upcast()
}
