//! One surface: an engine thread and the views it mounts on the GTK main
//! thread.
//!
//! The engine thread hands each commit to [`Sink`], which queues it and
//! wakes the main loop once (`MainContext::invoke`); the main thread
//! drains the queue and applies every batch in order ([`Surface::drain`]).
//! Native animations, the platform's own (transitions, screen transitions,
//! scroll glides: [`Surface::add_frame_callback`]) and JS frame requests
//! run on the root view's frame clock (`add_tick_callback`) while there is
//! something to do.
//!
//! The frame clock stops while the window is not shown (minimized, hidden,
//! on a compositor that throttles it), and what an animation's end does
//! (a view detached, a screen settled and reported, `finished` sent to JS,
//! a scroll's end) must still happen on time: [`Surface::keep_deadline`]
//! keeps the next such deadline with a one-shot main-loop timer, which
//! runs a frame only if the clock ran none since it came due.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use crossbeam_channel::{Receiver, Sender};
use gtk4::{self as gtk, glib, prelude::*};
use nsh_core::{EventKind, EventPayload, MountBatch, MountItem, NodeId, Points, ROOT_ID, Size};
use nsh_engine::{Engine, EngineConfig, EngineControl, Environment, MainThreadTask, MountSink};
use rustc_hash::FxHashMap;

use crate::{animation::UiAnimation, mount::Mounter, text::PangoTextEngine, view::NshView};

/// What the engine thread sends the main thread.
enum Message {
    Batch(MountBatch),
    Handled(u64),
    Error(String),
    Frame,
    HotUpdateFailed,
    /// A function the app runs on the main thread
    /// ([`MountSink::run_on_main_thread`]), after the batches before it.
    Run(MainThreadTask),
}

thread_local! {
    /// The surfaces of this (main) thread, by key: the sink wakes one by
    /// its key, as `invoke` closures must be `Send`.
    static SURFACES: RefCell<FxHashMap<u64, Weak<Surface>>> = RefCell::default();
}

static NEXT_KEY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// How long after a deadline the timer that keeps it fires
/// ([`Surface::keep_deadline`], seconds): more than a frame, so while the
/// window shows the frame clock's frame always comes first.
const LATE: f64 = 0.05;

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
}

/// Called when the app reports a fatal error (development hosts show it).
pub(crate) type ErrorHandler = Box<dyn Fn(&str)>;
type InputReady = Box<dyn FnOnce(Result<(), String>) + Send>;

/// One engine and its views.
pub(crate) struct Surface {
    key: u64,
    generation: Cell<u64>,
    events_handled: Cell<u64>,
    pub(crate) input_paused: Cell<bool>,
    pub(crate) paused_focus: RefCell<Option<glib::WeakRef<gtk::Widget>>>,
    pub(crate) outer: glib::WeakRef<gtk::Widget>,
    pending_pastes: Cell<usize>,
    input_ready: RefCell<Vec<InputReady>>,
    /// The root view (node [`ROOT_ID`]): the surface's widget.
    pub(crate) root: NshView,
    /// Views by node id, and what mounting needs between items.
    pub(crate) mounter: RefCell<Mounter>,
    /// The native animation graph.
    pub(crate) anim: RefCell<UiAnimation>,
    /// Stacks, screens and modals.
    pub(crate) nav: RefCell<crate::navigation::Nav>,
    /// The app's own windows (`<Window>`, `Window.open`), by the dialog
    /// root each shows ([`crate::window`]).
    pub(crate) windows: RefCell<rustc_hash::FxHashMap<nsh_core::NodeId, crate::window::AppWindow>>,
    /// What the main window keeps: its attributes, its state's
    /// bookkeeping ([`crate::window`]).
    pub(crate) main_window: RefCell<crate::window::MainWindow>,
    /// Pointer input state ([`crate::input`]).
    pub(crate) input: crate::input::Input,
    pub(crate) file_drop: crate::file_drop::State,
    engine: RefCell<Option<Engine>>,
    control: RefCell<Option<EngineControl>>,
    /// URLs the app was opened with before its engine started
    /// ([`Surface::open_url`]).
    pending_links: RefCell<Vec<String>>,
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
    /// Frame callbacks of the platform's own animations (transitions,
    /// screen transitions, scroll glides), called on every frame until
    /// they are done, each with its deadline ([`Next::At`]; a new one's is
    /// when it was added).
    frame_callbacks: RefCell<Vec<(FrameCallback, Option<f64>)>>,
    /// The time of the last frame run (seconds, the frame clock's): the
    /// clock's, or one a deadline ran without it. Frames never go back
    /// before it.
    last_frame: Cell<f64>,
    /// When the last frame ran (seconds, GLib's monotonic time, which the
    /// frame clock's times are on): whether frames come
    /// ([`Surface::keep_deadline`]).
    last_run: Cell<f64>,
    /// The deadline the scheduled timer waits for
    /// ([`Surface::keep_deadline`]).
    keeper: Cell<Option<f64>>,
    on_error: RefCell<Option<ErrorHandler>>,
    on_hot_update_failed: RefCell<Option<Box<dyn Fn()>>>,
    /// The model of a test session's app (`nsh test --target linux`).
    #[cfg(feature = "dev")]
    test_model: RefCell<Option<Arc<nsh_testing::agent::Model>>>,
    /// The GPU device shader views render with, opened when the first
    /// shader is mounted (`None` inside: there is none).
    shader_renderer: std::cell::OnceCell<Option<Rc<nsh_engine::shader::Renderer>>>,
    /// The engine's sounds and players ([`crate::audio`]).
    pub(crate) audio: crate::audio::Speaker,
    /// Where `asset:/` image URIs resolve ([`crate::image::set_asset_base`]).
    pub(crate) asset_base: RefCell<Option<crate::image::AssetBase>>,
    pub(crate) image_assets: RefCell<Option<nsh_core::image::loader::ReadAsset>>,
    /// The disk cache of downloaded images ([`crate::image::set_disk_cache`]).
    pub(crate) image_cache: RefCell<Option<nsh_core::image::DiskCache>>,
    /// The roots the app's `<Image>` files are read under
    /// ([`nsh_engine::Engine::media_files`]).
    pub(crate) media_files: RefCell<Arc<nsh_core::access::MediaFiles>>,
    /// What the running app may reach (checked for image redirects).
    pub(crate) access: RefCell<Arc<nsh_core::access::Access>>,
    /// Videos, web views and registered native components.
    pub(crate) native: crate::native::NativeState,
    /// The app's keyboard shortcuts ([`crate::keymap`]).
    pub(crate) keymap: crate::keymap::KeymapState,
    /// The window's chrome: title bar, menus ([`crate::chrome`]).
    pub(crate) chrome: crate::chrome::Chrome,
    /// Selections across the texts of selectable views
    /// ([`crate::selectable_view`]).
    pub(crate) selection: crate::selectable_view::State,
    /// The performance monitor, while it measures ([`crate::fps`]).
    fps: RefCell<Option<Rc<crate::fps::Fps>>>,
    pub(crate) fps_overlay: RefCell<glib::WeakRef<gtk::Overlay>>,
}

/// A per-frame callback ([`Surface::add_frame_callback`]): gets the frame
/// time in seconds, returns what it has left.
pub(crate) type FrameCallback = Box<dyn FnMut(&Rc<Surface>, f64) -> Next>;

/// What a frame callback has left after a frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Next {
    /// Nothing: it is not called again.
    Done,
    /// Drawing only (a scroll indicator's fade, keyframes repeating
    /// forever): the next frame, when there is one.
    Frame,
    /// Something that changes the app's state ends at this time (seconds,
    /// the frame clock's: a view detached, an event sent): it is called by
    /// then even while the frame clock stops ([`Surface::keep_deadline`]),
    /// and on every frame until then.
    At(f64),
}

impl Surface {
    /// The GPU device shader views render with ([`crate::shader`]), opened
    /// the first time one asks; without one the app hears that shader views
    /// draw nothing (`shadersAvailable()`).
    pub(crate) fn shader_renderer(&self) -> Option<Rc<nsh_engine::shader::Renderer>> {
        self.shader_renderer
            .get_or_init(|| {
                let renderer =
                    nsh_engine::shader::Renderer::new(nsh_engine::shader::PixelFormat::Rgba);
                if renderer.is_none() {
                    self.control(EngineControl::shaders_unavailable);
                }
                renderer.map(Rc::new)
            })
            .clone()
    }

    /// Settles [`Surface::shader_renderer`] as opened without a device, as
    /// a machine without one would: the tests open none.
    #[cfg(test)]
    pub(crate) fn without_shader_renderer(&self) {
        let _ = self.shader_renderer.set(None);
    }

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
            windows: RefCell::default(),
            main_window: RefCell::default(),
            input: Default::default(),
            file_drop: Default::default(),
            engine: RefCell::new(None),
            control: RefCell::new(None),
            pending_links: RefCell::default(),
            rx: RefCell::new(None),
            pending: RefCell::new(Arc::new(AtomicBool::new(false))),
            environment: Cell::new(environment),
            appearance: Cell::default(),
            host_environment: Cell::default(),
            host_tokens: RefCell::new(None),
            js_frame: Cell::new(false),
            ticking: Cell::new(false),
            frame_callbacks: RefCell::default(),
            last_frame: Cell::new(0.0),
            last_run: Cell::new(0.0),
            keeper: Cell::new(None),
            on_error: RefCell::new(None),
            on_hot_update_failed: RefCell::new(None),
            #[cfg(feature = "dev")]
            test_model: RefCell::default(),
            shader_renderer: std::cell::OnceCell::new(),
            audio: Default::default(),
            asset_base: RefCell::new(None),
            image_assets: RefCell::new(None),
            generation: Cell::new(0),
            events_handled: Cell::new(0),
            input_paused: Cell::new(false),
            paused_focus: RefCell::new(None),
            outer: glib::WeakRef::new(),
            pending_pastes: Cell::new(0),
            input_ready: RefCell::new(Vec::new()),
            image_cache: RefCell::new(None),
            media_files: RefCell::default(),
            access: RefCell::new(Arc::default()),
            native: Default::default(),
            keymap: Default::default(),
            chrome: Default::default(),
            selection: Default::default(),
            fps: RefCell::new(None),
            fps_overlay: RefCell::default(),
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
                clock.connect_layout(|_| {
                    crate::canvas::reveal();
                    crate::shader::reveal();
                });
            }
        });
        crate::input::install(&surface);
        crate::text_input::install_keyboard(&surface);
        crate::scroll::install_keyboard(&surface);
        crate::key_focus::install(&surface);
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
        if let Some(overlay) = self.fps_overlay.borrow().upgrade() {
            crate::fps::show(&overlay, &fps);
        }
        self.control(|c| c.set_perf_monitor(Some(fps.monitor.clone())));
        *self.fps.borrow_mut() = Some(fps);
    }

    #[cfg(test)]
    pub(crate) fn fps_for_test(&self) -> Rc<crate::fps::Fps> {
        self.fps.borrow().as_ref().unwrap().clone()
    }

    /// Stops measuring ([`Surface::enable_fps`]).
    pub(crate) fn disable_fps(&self) {
        if self.fps.take().is_some() {
            self.control(|c| c.set_perf_monitor(None));
        }
    }

    /// Its key ([`Surface::by_key`]).
    pub(crate) fn key(&self) -> u64 {
        self.key
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

    /// The surface `key` names, while it exists.
    pub(crate) fn by_key(key: u64) -> Option<Rc<Surface>> {
        SURFACES.with(|s| s.borrow().get(&key).and_then(Weak::upgrade))
    }

    /// Whether a native animation runs: the graph's (not one looping
    /// forever, which no test step waits for), or a navigation transition.
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.anim.borrow().finishing()
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

    /// Whether `nsh test` drives the app ([`Self::set_test_model`]): then
    /// the agent's pointer is its only one (`input::install_on`).
    pub(crate) fn testing(&self) -> bool {
        #[cfg(feature = "dev")]
        return self.test_model.borrow().is_some();
        #[cfg(not(feature = "dev"))]
        false
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
        // The embedding app's theme overrides are in the first frame, and
        // the links that came before are the app's address when its code
        // first runs (`UrlScheme.url()`).
        let tokens = self.host_tokens.borrow().clone();
        let links = self.pending_links.take();
        // The app reads the displays as it first renders.
        let displays = crate::window::displays();
        let setup = |control: &EngineControl| {
            if tokens.is_some() {
                control.set_tokens(tokens);
            }
            if !displays.is_empty() {
                control.set_displays(displays);
            }
            for url in links {
                control.dispatch_event(ROOT_ID, EventKind::UrlScheme, url_payload(url));
            }
        };
        match Engine::start_with(config, move || PangoTextEngine::new(family), sink, setup) {
            Ok(engine) => {
                // The app's downloaded images go through its disk cache.
                crate::image::set_disk_cache(self, engine.image_cache());
                *self.media_files.borrow_mut() = engine.media_files();
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
                crate::window::watch_displays(self);
            }
            Err(err) => log::error!("cannot start the engine: {err}"),
        }
    }

    /// Stops the app and removes its views.
    pub(crate) fn stop(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
        self.events_handled.set(0);
        self.paused_focus.borrow_mut().take();
        self.pending_pastes.set(0);
        crate::text_input::stopped(self);
        let waiters = self.input_ready.take();
        if !waiters.is_empty() && self.input_paused.get() {
            self.set_outer_sensitive(false);
        }
        for done in waiters {
            done(Err("the UI engine stopped while pausing input".into()));
        }
        crate::global_shortcut::clear(self);
        crate::tray::clear(self);
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
        crate::selectable_view::reset(self);
        crate::keymap::clear(self);
        crate::window::clear(self);
        self.js_frame.set(false);
    }

    /// Calls `f` with the engine's control, if an app runs.
    pub(crate) fn control(&self, f: impl FnOnce(&EngineControl)) {
        if let Some(control) = &*self.control.borrow() {
            f(control);
        }
    }

    pub(crate) fn admit_paste(&self) -> u64 {
        self.pending_pastes.set(self.pending_pastes.get() + 1);
        self.generation.get()
    }

    pub(crate) fn paste_is_current(&self, generation: u64) -> bool {
        self.generation.get() == generation
    }

    pub(crate) fn finish_paste(self: &Rc<Self>, generation: u64) {
        if !self.paste_is_current(generation) {
            return;
        }
        self.pending_pastes.set(self.pending_pastes.get() - 1);
        if self.pending_pastes.get() == 0 {
            for done in self.input_ready.take() {
                self.input_barrier(done);
            }
        }
    }

    /// Orders admitted native edits before the host's reload transaction.
    pub(crate) fn input_barrier(
        self: &Rc<Self>,
        done: impl FnOnce(Result<(), String>) + Send + 'static,
    ) {
        if self.pending_pastes.get() != 0 {
            self.input_ready.borrow_mut().push(Box::new(done));
            return;
        }
        Self::step_input_barrier(self, self.generation.get(), false, Box::new(done));
    }

    pub(crate) fn set_outer_sensitive(&self, sensitive: bool) {
        if let Some(outer) = self.outer.upgrade() {
            outer.set_sensitive(sensitive);
        }
    }

    fn step_input_barrier(self: &Rc<Self>, generation: u64, blurred: bool, done: InputReady) {
        crate::text_input::flush_changes(self);
        let Some(control) = self.control.borrow().clone() else {
            if self.input_paused.get() {
                self.set_outer_sensitive(false);
            }
            done(Err("the UI engine is not running".into()));
            return;
        };
        let key = self.key;
        let sent_before = control.events_sent();
        control.advance_clock(std::time::Duration::ZERO, move || {
            glib::MainContext::default().invoke(move || {
                let Some(surface) =
                    Self::by_key(key).filter(|surface| surface.generation.get() == generation)
                else {
                    done(Err("the UI engine changed while pausing input".into()));
                    return;
                };
                surface.drain();
                crate::text_input::flush_changes(&surface);
                if surface.pending_pastes.get() != 0 {
                    surface.input_ready.borrow_mut().push(done);
                    return;
                }
                if surface.events_sent() != sent_before
                    || surface.events_handled() < surface.events_sent()
                    || crate::text_input::has_pending_auto_focus(&surface)
                {
                    Self::step_input_barrier(&surface, generation, blurred, done);
                    return;
                }
                if crate::text_input::has_pending(&surface) {
                    crate::text_input::disarm(&surface);
                    if surface.input_paused.get() {
                        surface.set_outer_sensitive(false);
                    }
                    done(Err("pending input has no editable focus target".into()));
                    return;
                }
                if !blurred && surface.input_paused.get() {
                    let root = surface.root.upcast_ref::<gtk::Widget>();
                    *surface.paused_focus.borrow_mut() = root
                        .root()
                        .and_then(|r| r.focus())
                        .filter(|f| f == root || f.is_ancestor(root))
                        .map(|f| f.downgrade());
                    crate::text_input::blur_all(&surface);
                    surface.set_outer_sensitive(false);
                    crate::text_input::flush_changes(&surface);
                    if surface.events_sent() != sent_before {
                        Self::step_input_barrier(&surface, generation, true, done);
                        return;
                    }
                }
                if surface.input_paused.get() {
                    surface.set_outer_sensitive(false);
                }
                crate::text_input::disarm(&surface);
                done(Ok(()));
            });
        });
    }

    /// Sends an event to JS.
    pub(crate) fn event(&self, id: NodeId, kind: EventKind, payload: EventPayload) {
        self.control(|c| c.dispatch_event(id, kind, payload));
    }

    /// Hands the app a URL the system opened it with (`EventKind::UrlScheme`),
    /// kept until the engine starts, which applies it before the app's code
    /// first runs.
    pub(crate) fn open_url(&self, url: &str) {
        if self.control.borrow().is_none() {
            self.pending_links.borrow_mut().push(url.to_owned());
            return;
        }
        self.event(ROOT_ID, EventKind::UrlScheme, url_payload(url.to_owned()));
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

    /// Lays the app out at `width` × `height` before GTK sizes the root,
    /// which it does only as its window shows ([`crate::window::launch_hidden`]).
    pub(crate) fn assume_size(&self, width: f32, height: f32) {
        self.resized(width, height);
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
        crate::window::main_resized(self);
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
                Message::Handled(events) => {
                    self.events_handled.set(events);
                    crate::text_input::engine_caught_up(self);
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
                Message::Run(task) => task.run(),
            }
        }
        if applied {
            self.write_animations();
            // A batch may change what a running frame callback has left (a
            // view's removal on top of its transition, a push while a screen
            // transition runs, a scroll command while the indicator fades)
            // without it saying so before its next frame: each is due now,
            // so the next frame comes even while the clock stops.
            let now = self.now();
            for (_, at) in self.frame_callbacks.borrow_mut().iter_mut() {
                *at = Some(now);
            }
        }
        self.ensure_ticking();
    }

    fn apply(self: &Rc<Self>, batch: &MountBatch) {
        crate::access::prepare(batch);
        crate::text_input::begin_batch(self);
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
        crate::text_input::end_batch(self);
        // Windows whose first frame this was show.
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
        // No surface state borrowed while the app's components run.
        crate::native::component_animated(self, moved);
        crate::scroll::pin_animated_sticky(self);
        if !finished.is_empty() {
            self.control(|c| c.animations_finished(finished));
        }
    }

    /// Calls `f` on every frame until it is done ([`Next`]); the first
    /// time by now even while the frame clock stops.
    pub(crate) fn add_frame_callback(
        self: &Rc<Self>,
        f: impl FnMut(&Rc<Surface>, f64) -> Next + 'static,
    ) {
        let now = self.now();
        self.frame_callbacks
            .borrow_mut()
            .push((Box::new(f), Some(now)));
        self.ensure_ticking();
    }

    /// Now on the frame clock's clock (seconds): GDK's frame times are
    /// GLib's monotonic time. Never before the last frame, whose time the
    /// clock may have set a little ahead.
    fn now(&self) -> f64 {
        monotonic().max(self.last_frame.get())
    }

    /// Whether anything wants frames: animations of the graph, frame
    /// callbacks, a JS frame request.
    fn wants_frames(&self) -> bool {
        self.js_frame.get()
            || self.anim.try_borrow().map_or(true, |a| a.animating())
            || !self.frame_callbacks.borrow().is_empty()
    }

    /// Runs the tick callback while animations run, frame callbacks are
    /// left or JS wants a frame, and keeps their deadlines
    /// ([`Surface::keep_deadline`]).
    pub(crate) fn ensure_ticking(self: &Rc<Self>) {
        if !self.wants_frames() {
            return;
        }
        self.keep_deadline();
        if self.ticking.replace(true) {
            return;
        }
        let weak = Rc::downgrade(self);
        self.root.add_tick_callback(move |_, clock| {
            let Some(surface) = weak.upgrade() else {
                return glib::ControlFlow::Break;
            };
            // GDK frame times are microseconds; the animation graph runs on
            // seconds. Never before a frame a deadline ran meanwhile.
            let now = clock.frame_time() as f64 / 1_000_000.0;
            surface.frame(now.max(surface.last_frame.get()));
            if surface.wants_frames() {
                glib::ControlFlow::Continue
            } else {
                surface.ticking.set(false);
                glib::ControlFlow::Break
            }
        });
    }

    /// When the next thing that changes the app's state comes due without
    /// a frame: an animation of the graph or a frame callback ending.
    /// `None` when only drawing is left: an animation looping forever, a
    /// JS frame request.
    fn deadline(&self, now: f64) -> Option<f64> {
        // The graph is in use: look again soon.
        let graph = self
            .anim
            .try_borrow()
            .map_or(Some(now), |a| a.deadline(now));
        let callbacks = self
            .frame_callbacks
            .borrow()
            .iter()
            .filter_map(|(_, at)| *at)
            .reduce(f64::min);
        [graph, callbacks].into_iter().flatten().reduce(f64::min)
    }

    /// Makes what comes due happen on time while the frame clock stops: it
    /// does not tick while the window is minimized or hidden (or a
    /// compositor throttles it), and animations must still end (a
    /// transition detaches its views when it does, a modal reports its
    /// dismissal, an animation its end to JS, a scroll its end). A timer
    /// waits for the next deadline ([`Surface::deadline`]) and a little
    /// more ([`LATE`]); if no frame ran since it came due, it runs one,
    /// which steps everything to its time, ends what ended and gives the
    /// next deadline. While the window shows, frames always come first and
    /// the timer does nothing. Nothing is scheduled for what only draws (a
    /// spinner, a JS frame request), so a hidden window with an endless
    /// animation does no work.
    fn keep_deadline(self: &Rc<Self>) {
        let now = self.now();
        let Some(at) = self.deadline(now) else {
            return;
        };
        // One timer at a time: the one waiting for an earlier deadline
        // schedules the next when it fires.
        if self.keeper.get().is_some_and(|pending| pending <= at) {
            return;
        }
        self.keeper.set(Some(at));
        let weak = Rc::downgrade(self);
        // Whole milliseconds, rounded up: never before the deadline.
        let ms = ((at + LATE - now).max(0.0) * 1000.0).ceil() as u64;
        glib::timeout_add_local_once(Duration::from_millis(ms), move || {
            let Some(surface) = weak.upgrade() else {
                return;
            };
            // An earlier deadline took its place and schedules on.
            if surface.keeper.get() != Some(at) {
                return;
            }
            surface.keeper.set(None);
            // A frame ran since it came due: frames come and step it (the
            // frame clock may time a frame a little before it runs).
            if surface.last_run.get() < at {
                surface.frame(surface.now());
            }
            surface.keep_deadline();
        });
    }

    /// One frame at `now` (seconds, the frame clock's): the clock's, or
    /// one a deadline ran without it.
    fn frame(self: &Rc<Self>, now: f64) {
        self.last_frame.set(now);
        self.last_run.set(monotonic());
        if self.anim.borrow().animating() {
            self.anim.borrow_mut().tick(now);
            self.write_animations();
        }
        let callbacks = std::mem::take(&mut *self.frame_callbacks.borrow_mut());
        let mut kept: Vec<(FrameCallback, Option<f64>)> = callbacks
            .into_iter()
            .filter_map(|(mut f, _)| match f(self, now) {
                Next::Done => None,
                Next::Frame => Some((f, None)),
                Next::At(at) => Some((f, Some(at))),
            })
            .collect();
        {
            // Those added during the frame run from the next one.
            let mut added = self.frame_callbacks.borrow_mut();
            kept.append(&mut added);
            *added = kept;
        }
        if self.js_frame.replace(false) {
            self.control(|c| c.frame());
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        crate::global_shortcut::clear(self);
        crate::tray::clear(self);
        let key = self.key;
        crate::text_input::disposed(key);
        let _ = SURFACES.try_with(|s| s.borrow_mut().remove(&key));
    }
}

/// The payload of a `UrlScheme` event reporting `url`.
fn url_payload(url: String) -> EventPayload {
    EventPayload::Map(vec![(
        nsh_core::url_scheme::URL,
        nsh_core::PayloadValue::Str(url),
    )])
}

/// GLib's monotonic time in seconds, the clock GDK's frame times are on.
fn monotonic() -> f64 {
    glib::monotonic_time() as f64 / 1_000_000.0
}

/// The widget type a surface is shown in.
pub(crate) fn widget(surface: &Surface) -> gtk::Widget {
    surface.root.clone().upcast()
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::gtk_test;

    /// Without frames (the root is in no window, as in a hidden one), a
    /// frame callback still runs by its deadline, and one that only draws
    /// is not run again.
    #[test]
    fn deadlines_are_kept_without_frames() {
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            let calls = Rc::new(RefCell::new(Vec::new()));
            let seen = calls.clone();
            surface.add_frame_callback(move |_, now| {
                let mut seen = seen.borrow_mut();
                seen.push(now);
                match seen.len() {
                    1 => Next::At(now + 0.02),
                    2 => Next::Frame,
                    _ => Next::Done,
                }
            });
            assert!(gtk_test::wait_until(|| calls.borrow().len() >= 2));
            let times = calls.borrow().clone();
            assert!(times[1] >= times[0] + 0.02, "{times:?}");
            let until = Instant::now() + Duration::from_millis(200);
            gtk_test::wait_until(|| Instant::now() >= until);
            assert_eq!(calls.borrow().len(), 2, "drawing only, without frames");
        });
    }
}
