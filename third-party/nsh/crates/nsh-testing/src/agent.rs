//! The test agent of a real host (`nsh test --target`, feature `agent`):
//! it takes the steps of a test on the app the host shows, as the
//! headless driver takes them on a model of the views, but acts with the
//! platform's own input at the views the selectors name.
//!
//! The host keeps a [`Model`]: it hands it every batch it applied (on its
//! main thread) and the app's errors, and the model keeps the same
//! [`Screen`] the headless driver does, so selectors find the same views
//! on every platform. The host's dev client hands each [`TestStep`] to an
//! [`Agent`] on a thread of its own, which resolves the selector on the
//! model, asks the platform ([`Native`]) where the view is on screen and
//! acts there (a click or a tap, a drag, typed keys), then waits until the
//! app is quiet: no batch, no native animation that ends by itself (one
//! that loops forever, a spinner, is not waited for) and no window of the
//! app's own waiting to show for 100 ms, 2 s at most. [`Native`]'s calls
//! come from that thread; implementations do their work on the main thread
//! and return when it is done.

use std::{
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::Duration,
};

// The core's: std's panics in WebAssembly, where the web's page keeps the
// model.
use nsh_core::time::Instant;
use nsh_core::{
    MountBatch, NodeId,
    geometry::{Bounds, Point, Points, Size, point},
};
use nsh_dev::protocol::{
    AccessibilityNode, PickTarget, SceneQuery, SpanStyle, StepOutcome, TestStep, ViewLayout,
    ViewStyle,
};

mod forward;

pub use self::forward::{Outgoing, Send as SendOutgoing};
pub use crate::screen::Pick;
use crate::{DragOptions, MemoryStorage, screen::Screen, selector::Selector};

/// How far a dragging finger moves in a display frame, as headless drags
/// move it.
pub const DRAG_STEP: Points = Points(10.0);
/// A display frame, between a drag's moves.
pub const FRAME: Duration = Duration::from_millis(16);
/// How long a dragging finger rests where it lands before it moves, as a
/// hand does: the views under it hear it land (a JS responder takes it)
/// before a drag starts.
pub const LANDING: Duration = crate::drag::LANDING;

/// The positions of a finger dragged from `from` to `to`
/// ([`Native::drag`]), after `from`, a display frame apart: [`DRAG_STEP`]
/// points at most each, the last at `to`.
pub fn drag_path(from: Point<Points>, to: Point<Points>) -> impl Iterator<Item = Point<Points>> {
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let steps = (dx.abs().max(dy.abs()) / DRAG_STEP).ceil().max(1.0) as u32;
    (1..=steps).map(move |i| {
        let t = i as f32 / steps as f32;
        Point::new(from.x + dx * t, from.y + dy * t)
    })
}

/// Refuses `options` that ask a drag for more than an agent resting
/// [`LANDING`] does (a custom hold), before it puts a pointer down: `step`
/// names the test's step (`"drag"`, `"dragAndHold"`).
pub fn refuse_custom_drag(step: &str, options: DragOptions) -> Result<(), String> {
    match options.hold {
        Some(hold) if hold != LANDING => Err(crate::failure::unsupported_here(
            step,
            "this platform's test agent does not support a custom hold",
        )),
        _ => Ok(()),
    }
}

/// How long after the last batch the app is quiet.
const QUIET: Duration = Duration::from_millis(100);
/// How long a step waits for the app to be quiet at most.
const SETTLE: Duration = Duration::from_secs(2);
/// How often waits look again while nothing comes.
const POLL: Duration = Duration::from_millis(20);
/// On a manual clock: how long a wait looks in real time for a batch
/// between two of its frames, for what the frame brought (applied on the
/// main thread) and what the app's clock does not bring (a response the
/// test gives).
const FRAME_LOOK: Duration = Duration::from_millis(2);
/// The wall time `ms` milliseconds from the Unix epoch (before it when
/// negative).
fn unix_time(ms: f64) -> std::time::SystemTime {
    let since = Duration::from_secs_f64(ms.abs() / 1000.0);
    if ms >= 0.0 {
        std::time::UNIX_EPOCH + since
    } else {
        std::time::UNIX_EPOCH - since
    }
}

/// How long moving the app's clock may take at most (the timers due on
/// the way run meanwhile).
#[cfg(not(target_arch = "wasm32"))]
const CLOCK_TIMEOUT: Duration = Duration::from_secs(60);
/// A long press's hold when the view does not say (`delayLongPress`).
const LONG_PRESS: Duration = Duration::from_millis(500);
/// How many gestures scrolling a view into view takes at most: only a
/// guard against a view that keeps moving without ever arriving. Gestures
/// that move nothing end it sooner ([`anchor`]), and each moves at most
/// part of its scroll view, so a row far down a long list in a small window
/// (the gallery's home at 640x480 needs about 30) takes many.
const SCROLLS_INTO_VIEW: usize = 100;

/// What a host's app shows, as test steps see it: the batches the host
/// applied and the errors the app reported.
#[derive(Default)]
pub struct Model {
    state: Mutex<State>,
    changed: Condvar,
    /// What the test set the app up with ([`Model::set_up`]).
    setup: Mutex<Option<Setup>>,
}

/// What a test session's app starts with, in place of the platform's.
struct Setup {
    storage: Arc<MemoryStorage>,
    /// What the test fixes of the environment.
    pins: nsh_engine::EnvironmentPins,
    /// The clipboard the app's calls are served from: the test's own.
    clipboard: Arc<nsh_core::clipboard::MemoryClipboard>,
    forwarder: Arc<forward::Forwarder>,
    /// Where each batch's items go when the test traces the app.
    trace: Option<SendOutgoing>,
    /// The manual clock the app runs on, when the test gave it one.
    clock: Option<nsh_core::time::Clock>,
    /// The engine of the app ([`Model::engine_started`]): it moves the
    /// clock.
    engine: Option<nsh_engine::EngineControl>,
    /// The launch parameters the test gave the app (`host.params`).
    host_params: Option<serde_json::Map<String, serde_json::Value>>,
    /// The embedding app's channel with the app ([`Model::set_up_engine`]),
    /// whose events the test sends.
    host: Option<nsh_engine::HostChannel>,
    /// The URLs the app opened: recorded, never opened.
    opened_urls: Arc<Mutex<Vec<String>>>,
    /// Whether the app's sockets and WebSockets reach the network
    /// (`network: "live"`); otherwise the engine refuses them.
    live_network: bool,
}

#[derive(Default)]
struct State {
    screen: Screen,
    /// Batches applied so far.
    batches: u64,
    /// When the last one was.
    last: Option<Instant>,
    /// What the app threw since the last step looked.
    errors: Vec<String>,
}

impl Model {
    /// Takes in a batch the host applied (on its main thread, after
    /// applying it).
    pub fn apply(&self, batch: &MountBatch) {
        // Before the step that brought it is done: the test prints it under
        // that step.
        let trace = self
            .setup
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|setup| setup.trace.clone());
        if let Some(send) = trace {
            send(Outgoing::Trace(crate::trace::item_lines(batch)));
        }
        let mut state = self.lock();
        state.screen.apply(batch);
        state.batches += 1;
        state.last = Some(Instant::now());
        drop(state);
        self.changed.notify_all();
    }

    /// The app threw `message` (an exception that escaped a callback, a
    /// bundle that did not load): the step taken meanwhile fails with it.
    pub fn error(&self, message: impl Into<String>) {
        self.lock().errors.push(message.into());
        self.changed.notify_all();
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// What the test sets the app up with (before its first bundle): the
    /// storage entries it starts with, whether it traces the app (`nsh test
    /// --trace`), what it fixes of the environment and the clipboard's text,
    /// and what sends the test its requests and, when traced, each batch
    /// ([`Model::set_up_engine`], [`Model::fetch_reply`]).
    pub fn set_up(
        &self,
        storage: Vec<(String, String)>,
        trace: bool,
        environment: nsh_dev::protocol::TestEnvironment,
        send: SendOutgoing,
    ) {
        let mut pins = nsh_engine::EnvironmentPins::default();
        pins.locale = environment
            .locale
            .as_deref()
            .and_then(nsh_core::platform::Locale::parse);
        pins.time_zone = environment
            .time_zone
            .as_deref()
            .and_then(nsh_core::platform::TimeZone::parse);
        pins.languages = environment
            .languages
            .as_ref()
            .and_then(|tags| nsh_core::platform::Languages::parse(tags.iter().map(String::as_str)));
        pins.hour_cycle = environment
            .hour_cycle
            .as_deref()
            .and_then(nsh_core::platform::HourCycle::parse);
        pins.first_day_of_week = environment
            .first_day_of_week
            .and_then(nsh_core::platform::Weekday::from_number);
        pins.measurement_system = environment
            .measurement_system
            .as_deref()
            .and_then(nsh_core::platform::MeasurementSystem::parse);
        pins.temperature_unit = environment
            .temperature_unit
            .as_deref()
            .and_then(nsh_core::platform::TemperatureUnit::parse);
        pins.reduce_motion = environment.reduced_motion;
        pins.safe_area =
            environment
                .safe_area
                .map(|[top, right, bottom, left]| nsh_core::geometry::Edges {
                    top: Points(top),
                    right: Points(right),
                    bottom: Points(bottom),
                    left: Points(left),
                });
        *self.setup.lock().unwrap_or_else(|e| e.into_inner()) = Some(Setup {
            storage: MemoryStorage::new(storage),
            pins,
            clipboard: Arc::new(nsh_core::clipboard::MemoryClipboard::new(
                environment.clipboard,
            )),
            trace: trace.then(|| send.clone()),
            forwarder: forward::Forwarder::new(send),
            clock: environment
                .clock
                .map(|ms| nsh_core::time::Clock::manual(unix_time(ms)).with_frames()),
            engine: None,
            host_params: environment.host_params,
            host: None,
            opened_urls: Arc::default(),
            live_network: environment.live_network == Some(true),
        });
    }

    /// Sets `config`, the engine of a test session's app, up as the test
    /// says ([`Model::set_up`]; nothing before): its storage is the test's,
    /// its requests go to the test (which answers them or lets them through
    /// to the host's network), its sockets and WebSockets are refused
    /// unless the test lets it reach the network (`network: "live"`), a
    /// traced app's engine logs each commit's timings, the environment
    /// keeps what the test fixed, the app's clipboard calls are served from
    /// the test's clipboard, and it runs on the test's manual clock when
    /// there is one (which also moves with the display's frames). The test plays the embedding app on the view's
    /// channel (`config.host`): its launch parameters, and a URL handler
    /// that records the URLs the app opens instead of opening them. The
    /// host hands the engine back once it started
    /// ([`Model::engine_started`]).
    pub fn set_up_engine(&self, config: &mut nsh_engine::EngineConfig) {
        let mut setup = self.setup.lock().unwrap_or_else(|e| e.into_inner());
        let Some(setup) = &mut *setup else { return };
        config.network = Some(Arc::new(forward::ForwardNetwork {
            forwarder: setup.forwarder.clone(),
            platform: config.network.take(),
        }));
        if !setup.live_network {
            config.refuse_connections = Some(crate::failure::refuse_connections());
        }
        config.storage = Some(setup.storage.clone() as Arc<dyn nsh_core::storage::StorageBackend>);
        config.trace |= setup.trace.is_some();
        config.pinned = setup.pins;
        config.clipboard =
            Some(setup.clipboard.clone() as Arc<dyn nsh_core::clipboard::ClipboardBackend>);
        if let Some(clock) = &setup.clock {
            config.clock = clock.clone();
        }
        // The test plays the embedding app: its launch parameters, and the
        // URLs the app opens recorded rather than opened.
        if let Some(params) = &setup.host_params {
            config.host.set_params(params.clone());
        }
        let opened = setup.opened_urls.clone();
        config.host.handle_open_url(move |request| {
            opened
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(request.url().to_owned());
            request.handled();
        });
        setup.host = Some(config.host.clone());
    }

    /// The embedding app sends event `name` with `data` to the app
    /// (`app.host.send`).
    pub fn send_host_event(&self, name: &str, data: serde_json::Value) -> Result<(), String> {
        let setup = self.setup.lock().unwrap_or_else(|e| e.into_inner());
        let host = setup
            .as_ref()
            .and_then(|s| s.host.clone())
            .ok_or("the app's engine did not start")?;
        drop(setup);
        host.send(name, data)
    }

    /// The URLs the app opened, in order (`app.openedUrls`).
    pub fn opened_urls(&self) -> Vec<String> {
        let setup = self.setup.lock().unwrap_or_else(|e| e.into_inner());
        setup.as_ref().map_or_else(Vec::new, |s| {
            s.opened_urls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        })
    }

    /// The engine [`Model::set_up_engine`] set up started: the test moves
    /// its clock through it.
    pub fn engine_started(&self, engine: nsh_engine::EngineControl) {
        // Steps reach every view of a page, below its fold too, as the
        // headless driver's do.
        engine.set_content_culling(false);
        if let Some(setup) = &mut *self.setup.lock().unwrap_or_else(|e| e.into_inner()) {
            setup.engine = Some(engine);
        }
    }

    /// Moves the app's manual clock as `change` says, as the headless
    /// driver moves it; an error when the app runs on the system's clock.
    /// Off WebAssembly it returns once the engine got there (what ran was
    /// submitted); the web's page, whose thread the engine runs on, pumps
    /// it right after.
    pub fn move_clock(&self, change: nsh_dev::protocol::ClockChange) -> Result<(), String> {
        use nsh_dev::protocol::ClockChange;
        let (clock, engine) = {
            let setup = self.setup.lock().unwrap_or_else(|e| e.into_inner());
            let setup = setup.as_ref();
            match (
                setup.and_then(|s| s.clock.clone()),
                setup.and_then(|s| s.engine.clone()),
            ) {
                (Some(clock), Some(engine)) => (clock, engine),
                (None, _) => {
                    return Err(
                        "the app runs on the system's clock: open it with a manual one \
                                (`open(entry, { clock: {} })`)"
                            .into(),
                    );
                }
                (Some(_), None) => return Err("the app's engine did not start".into()),
            }
        };
        let by = match change {
            ClockChange::RunFor { ms } => Duration::from_millis(ms),
            ClockChange::FastForward { ms } => {
                clock.advance_to(clock.now() + Duration::from_millis(ms));
                Duration::ZERO
            }
            ClockChange::SetSystemTime { unix_ms } => {
                clock.set_system_time(unix_time(unix_ms));
                return Ok(());
            }
        };
        #[cfg(not(target_arch = "wasm32"))]
        {
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            engine.advance_clock(by, move || {
                let _ = tx.send(());
            });
            rx.recv_timeout(CLOCK_TIMEOUT).map_err(|_| {
                format!(
                    "the app's clock did not get there in {} s",
                    CLOCK_TIMEOUT.as_secs()
                )
            })
        }
        #[cfg(target_arch = "wasm32")]
        {
            engine.advance_clock(by, || {});
            Ok(())
        }
    }

    /// The text on the test's clipboard (after [`Model::set_up`]).
    pub fn clipboard_text(&self) -> Option<String> {
        use nsh_core::clipboard::ClipboardBackend as _;
        let setup = self.setup.lock().unwrap_or_else(|e| e.into_inner());
        setup.as_ref().and_then(|s| s.clipboard.text())
    }

    /// The test's answer to the app's request `id` (one event of it).
    pub fn fetch_reply(&self, id: u64, reply: nsh_dev::protocol::FetchReply) {
        let forwarder = self
            .setup
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|s| s.forwarder.clone());
        if let Some(forwarder) = forwarder {
            forwarder.reply(id, reply);
        }
    }

    /// The app's storage's entries now (empty before [`Model::set_up`]).
    fn storage_entries(&self) -> std::collections::BTreeMap<String, String> {
        let setup = self.setup.lock().unwrap_or_else(|e| e.into_inner());
        setup
            .as_ref()
            .map(|s| s.storage.entries())
            .unwrap_or_default()
    }
}

/// How busy the app is: what [`Agent`]'s waits look at.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Activity {
    /// Batches applied so far.
    pub batches: u64,
    /// How long ago the last one was (`None`: none yet).
    pub since_last: Option<Duration>,
}

/// The app as an [`Agent`] sees it: the host's [`Model`] (the agent runs on
/// the host), or one asked about through the host ([`RemoteScene`]: the
/// web, whose agent runs in `nsh`).
pub trait Scene: Send + Sync {
    /// How busy the app is.
    fn activity(&self) -> Result<Activity, String>;
    /// Waits until a batch after the `seen`th came or the app threw,
    /// `timeout` at most.
    fn wait_for_batch(&self, seen: u64, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match self.activity() {
                Ok(a) if a.batches <= seen => std::thread::sleep(POLL.min(timeout)),
                _ => return,
            }
        }
    }
    /// The app's errors since the last time, taken.
    fn take_errors(&self) -> Result<Vec<String>, String>;
    /// The semantic text of a composite input, when its native field is a sink.
    fn input_value_text(&self, _selector: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    /// The one view `selector` names for a step on `target`.
    fn pick(&self, selector: &str, target: PickTarget) -> Result<Pick, String>;
    /// The scroll views around `id`, innermost first, and whether each
    /// scrolls horizontally.
    fn scroll_ancestors(&self, id: NodeId) -> Result<Vec<(NodeId, bool)>, String>;
    /// The views inside scroll view `id` that take a finger's drag
    /// themselves (responders, pans): a finger scrolling it lands
    /// elsewhere. None where the scene cannot tell.
    fn drag_takers(&self, id: NodeId) -> Result<Vec<NodeId>, String> {
        let _ = id;
        Ok(Vec::new())
    }
    /// `id`'s long press delay in milliseconds, if it says.
    fn long_press_delay(&self, id: NodeId) -> Result<Option<f32>, String>;
    /// Whether scroll view `id` scrolls horizontally.
    fn horizontal(&self, id: NodeId) -> Result<bool, String>;
    /// The texts on screen, in order.
    fn texts(&self) -> Result<Vec<String>, String>;
    /// How many views `selector` matches.
    fn count(&self, selector: &str) -> Result<usize, String>;
    /// Whether a view matches `selector`.
    fn matches(&self, selector: &str) -> Result<bool, String>;
    /// Whether the view `selector` names takes input.
    fn enabled(&self, selector: &str) -> Result<bool, String>;
    /// The resolved style of the first character `selector` names.
    fn span_style(&self, selector: &str) -> Result<SpanStyle, String>;
    /// The style of the view `selector` names, `None` when none matches.
    fn view_style(&self, selector: &str) -> Result<Option<ViewStyle>, String>;
    /// Where layout placed the view `selector` names, `None` when none
    /// matches.
    fn layout(&self, selector: &str) -> Result<Option<ViewLayout>, String>;
    /// The accessibility tree from the view `selector` names (the root
    /// without one), `None` when none matches.
    fn accessibility(&self, selector: Option<&str>) -> Result<Option<AccessibilityNode>, String>;
    /// The input `selector` names.
    fn input_id(&self, selector: &str) -> Result<Option<NodeId>, String>;
    /// The dialogs the app showed.
    fn dialogs(&self) -> Result<Vec<nsh_core::Dialog>, String>;
    /// The oldest dialog not answered yet.
    fn pending_dialog(&self) -> Result<Option<nsh_core::Dialog>, String>;
    /// The oldest dialog was answered.
    fn answered(&self) -> Result<(), String>;
    /// The context menu the app shows (`Menu.popup`), if one is open.
    fn menu(&self) -> Result<Option<Vec<nsh_core::desktop::MenuItem>>, String>;
    /// The open context menu was chosen from or closed.
    fn menu_closed(&self) -> Result<(), String>;
    /// The text on the test's clipboard.
    fn clipboard(&self) -> Result<Option<String>, String>;
    /// The app's storage's entries.
    fn storage(&self) -> Result<std::collections::BTreeMap<String, String>, String>;
    /// The window's content is `size` ([`Native::viewport`]): what lies
    /// outside it, and no scroll view brings in, is not on screen.
    fn set_viewport(&self, size: Size<Points>) -> Result<(), String>;
    /// The text view showing span `id` (a nested text that takes presses)
    /// and where in its text the span is (UTF-16 units); `None` for a view.
    fn span(&self, id: NodeId) -> Result<Option<(NodeId, u32, u32)>, String>;
    /// The canvas containing the one node `selector` names, and its
    /// center in that canvas's coordinates; `None` for an ordinary view.
    fn canvas_node(&self, selector: &str) -> Result<Option<(NodeId, Point<Points>)>, String> {
        let _ = selector;
        Ok(None)
    }
    /// The view `selector` matches inside view `id` (a text in the button
    /// a press goes to), whose middle a press lands on; `None` when the
    /// match is `id` itself.
    fn match_inside(&self, selector: &str, id: NodeId) -> Result<Option<NodeId>, String> {
        let _ = (selector, id);
        Ok(None)
    }
    /// Moves the app's manual clock ([`Model::move_clock`]).
    fn move_clock(&self, change: nsh_dev::protocol::ClockChange) -> Result<(), String>;
    /// Whether the app runs on a manual clock (`open`'s `clock`), which
    /// the agent moves as time passes in a step (a long press's hold) and
    /// in a wait (`waitFor`, `waitUntil`).
    fn manual_clock(&self) -> bool {
        false
    }
    /// The embedding app sends event `name` to the app
    /// ([`Model::send_host_event`]).
    fn send_host_event(&self, name: &str, data: serde_json::Value) -> Result<(), String>;
    /// The URLs the app opened ([`Model::opened_urls`]).
    fn opened_urls(&self) -> Result<Vec<String>, String>;
    /// The ids of the app's open windows, in opening order
    /// (`app.windowIds()`). Off the desktops (the web) there are none.
    fn window_ids(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    /// The root of the app's window `id` while it is open (`"main"`: the
    /// main window's, [`nsh_core::ROOT_ID`]). Without windows of the app's
    /// own (the web), only the main one.
    fn window_root(&self, id: &str) -> Result<Option<NodeId>, String> {
        Ok((id == "main").then_some(nsh_core::ROOT_ID))
    }
    /// Tells the scene a window of the app's own is `size` points: its
    /// views are clipped to that, not to the host surface's viewport.
    fn set_window_size(&self, root: NodeId, size: Size<Points>) -> Result<(), String> {
        let _ = (root, size);
        Ok(())
    }
    /// The size of the window `root` shows (`None`: the platform cannot
    /// tell, and the host surface's viewport is used).
    fn window_size(&self, root: NodeId) -> Option<Size<Points>> {
        let _ = root;
        None
    }
    /// The root of the window view `id` is in (the main window's when it is
    /// in none of the app's own).
    fn window_of(&self, id: NodeId) -> Result<NodeId, String> {
        let _ = id;
        Ok(nsh_core::ROOT_ID)
    }
}

impl Scene for Model {
    fn input_value_text(&self, selector: &str) -> Result<Option<String>, String> {
        let state = self.lock();
        let Some(id) = state.screen.input_id(selector)? else {
            return Ok(None);
        };
        Ok(state.screen.semantic_input_text(id).map(str::to_owned))
    }
    fn window_ids(&self) -> Result<Vec<String>, String> {
        Ok(self.lock().screen.window_ids())
    }
    fn window_root(&self, id: &str) -> Result<Option<NodeId>, String> {
        Ok(self.lock().screen.window_root(id))
    }
    fn set_window_size(&self, root: NodeId, size: Size<Points>) -> Result<(), String> {
        let mut state = self.lock();
        state.screen.set_window_size(root, size);
        Ok(())
    }
    fn window_size(&self, root: NodeId) -> Option<Size<Points>> {
        self.lock().screen.window_size(root)
    }
    fn window_of(&self, id: NodeId) -> Result<NodeId, String> {
        Ok(self.lock().screen.window_of(id))
    }
    fn canvas_node(&self, selector: &str) -> Result<Option<(NodeId, Point<Points>)>, String> {
        Ok(self.lock().screen.canvas_node(&Selector::parse(selector)?))
    }
    fn match_inside(&self, selector: &str, id: NodeId) -> Result<Option<NodeId>, String> {
        Ok(self
            .lock()
            .screen
            .match_inside(&Selector::parse(selector)?, id))
    }
    fn activity(&self) -> Result<Activity, String> {
        let state = self.lock();
        Ok(Activity {
            batches: state.batches,
            since_last: state.last.map(|t| t.elapsed()),
        })
    }
    fn wait_for_batch(&self, seen: u64, timeout: Duration) {
        let state = self.lock();
        let _ = self
            .changed
            .wait_timeout_while(state, timeout, |s| s.batches <= seen && s.errors.is_empty());
    }
    fn take_errors(&self) -> Result<Vec<String>, String> {
        Ok(std::mem::take(&mut self.lock().errors))
    }
    fn pick(&self, selector: &str, target: PickTarget) -> Result<Pick, String> {
        let parsed = Selector::parse(selector)?;
        let state = self.lock();
        let screen = &state.screen;
        let picked = match target {
            PickTarget::Pressable => screen.pressable(&parsed),
            PickTarget::LongPressable => screen.long_pressable(&parsed),
            PickTarget::Input => screen.input_view(&parsed),
            PickTarget::ScrollView => screen.scroll_view(&parsed),
            PickTarget::View => screen.view(&parsed),
        };
        if matches!(target, PickTarget::Input)
            && let Pick::One(id) = picked
            && let Some(cover) = screen.input_cover(id)
        {
            return Err(crate::failure::covered(
                selector,
                &screen.selector_of(cover),
            ));
        }
        Ok(picked)
    }
    fn scroll_ancestors(&self, id: NodeId) -> Result<Vec<(NodeId, bool)>, String> {
        Ok(self.lock().screen.scroll_ancestors(id))
    }
    fn drag_takers(&self, id: NodeId) -> Result<Vec<NodeId>, String> {
        Ok(self.lock().screen.drag_takers(id))
    }
    fn long_press_delay(&self, id: NodeId) -> Result<Option<f32>, String> {
        Ok(self.lock().screen.long_press_delay(id))
    }
    fn horizontal(&self, id: NodeId) -> Result<bool, String> {
        Ok(self.lock().screen.scroll(id).is_some_and(|s| s.horizontal))
    }
    fn texts(&self) -> Result<Vec<String>, String> {
        Ok(self
            .lock()
            .screen
            .texts()
            .into_iter()
            .map(str::to_owned)
            .collect())
    }
    fn count(&self, selector: &str) -> Result<usize, String> {
        self.lock().screen.count(selector)
    }
    fn matches(&self, selector: &str) -> Result<bool, String> {
        self.lock().screen.matches(selector)
    }
    fn enabled(&self, selector: &str) -> Result<bool, String> {
        self.lock().screen.enabled(selector)
    }
    fn span_style(&self, selector: &str) -> Result<SpanStyle, String> {
        let style = self.lock().screen.span_style(selector)?;
        let mut span = SpanStyle::default();
        span.color = style.color.0;
        span.background = style.background.map(|b| b.color.0);
        span.font_size = style.font_size.0;
        span.font_weight = style.font_weight;
        span.italic = style.italic;
        span.underline = style.decoration.underline;
        span.line_through = style.decoration.line_through;
        Ok(span)
    }
    fn view_style(&self, selector: &str) -> Result<Option<ViewStyle>, String> {
        Ok(self.lock().screen.view_style(selector)?.map(|s| {
            let mut style = ViewStyle::default();
            style.background_color = s.background_color;
            style.opacity = s.opacity;
            style.effective_opacity = s.effective_opacity;
            style
        }))
    }
    fn layout(&self, selector: &str) -> Result<Option<ViewLayout>, String> {
        Ok(self
            .lock()
            .screen
            .layout(selector)?
            .map(crate::screen::protocol_layout))
    }
    fn accessibility(&self, selector: Option<&str>) -> Result<Option<AccessibilityNode>, String> {
        Ok(self
            .lock()
            .screen
            .accessibility(selector)?
            .map(crate::screen::protocol_accessibility))
    }
    fn input_id(&self, selector: &str) -> Result<Option<NodeId>, String> {
        self.lock().screen.input_id(selector)
    }
    fn dialogs(&self) -> Result<Vec<nsh_core::Dialog>, String> {
        Ok(self.lock().screen.dialogs().to_vec())
    }
    fn pending_dialog(&self) -> Result<Option<nsh_core::Dialog>, String> {
        Ok(self.lock().screen.pending_dialog().cloned())
    }
    fn answered(&self) -> Result<(), String> {
        self.lock().screen.answered();
        Ok(())
    }
    fn menu(&self) -> Result<Option<Vec<nsh_core::desktop::MenuItem>>, String> {
        Ok(self.lock().screen.menu().map(<[_]>::to_vec))
    }
    fn menu_closed(&self) -> Result<(), String> {
        self.lock().screen.menu_closed();
        Ok(())
    }
    fn clipboard(&self) -> Result<Option<String>, String> {
        Ok(self.clipboard_text())
    }
    fn storage(&self) -> Result<std::collections::BTreeMap<String, String>, String> {
        Ok(self.storage_entries())
    }
    fn set_viewport(&self, size: Size<Points>) -> Result<(), String> {
        self.lock().screen.set_viewport(size);
        Ok(())
    }
    fn span(&self, id: NodeId) -> Result<Option<(NodeId, u32, u32)>, String> {
        Ok(self.lock().screen.span(id))
    }
    fn move_clock(&self, change: nsh_dev::protocol::ClockChange) -> Result<(), String> {
        Model::move_clock(self, change)
    }
    fn manual_clock(&self) -> bool {
        let setup = self.setup.lock().unwrap_or_else(|e| e.into_inner());
        setup.as_ref().is_some_and(|s| s.clock.is_some())
    }
    fn send_host_event(&self, name: &str, data: serde_json::Value) -> Result<(), String> {
        Model::send_host_event(self, name, data)
    }
    fn opened_urls(&self) -> Result<Vec<String>, String> {
        Ok(Model::opened_urls(self))
    }
}

/// `pick` as a [`SceneQuery::Pick`]'s answer: `{"one": id}`, `"none"`,
/// `{"many": n}` or `"disabled"`.
/// A context menu's item as a scene's answer carries it.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MenuValue {
    Separator,
    Action {
        id: u32,
        label: String,
        enabled: bool,
        checked: Option<bool>,
    },
    Submenu {
        label: String,
        enabled: bool,
        items: Vec<MenuValue>,
    },
}

impl MenuValue {
    fn into_item(self) -> nsh_core::desktop::MenuItem {
        use nsh_core::desktop::{MenuAction, MenuItem};
        match self {
            MenuValue::Separator => MenuItem::Separator,
            MenuValue::Action {
                id,
                label,
                enabled,
                checked,
            } => MenuItem::Action(MenuAction {
                id,
                label,
                shortcut: None,
                enabled,
                checked,
                role: None,
                when: nsh_core::keymap::When::Always,
                icon: None,
                symbol: None,
                destructive: false,
            }),
            MenuValue::Submenu {
                label,
                enabled,
                items,
            } => MenuItem::Submenu {
                label,
                enabled,
                items: items.into_iter().map(MenuValue::into_item).collect(),
                // A scene's answer is about what a test can ask of a menu.
                icon: None,
                symbol: None,
                inline: false,
            },
        }
    }
}

/// `items` as a scene's answer carries them.
fn menu_value(items: Vec<nsh_core::desktop::MenuItem>) -> Vec<MenuValue> {
    use nsh_core::desktop::MenuItem;
    items
        .into_iter()
        .map(|item| match item {
            MenuItem::Separator => MenuValue::Separator,
            MenuItem::Action(action) => MenuValue::Action {
                id: action.id,
                label: action.label,
                enabled: action.enabled,
                checked: action.checked,
            },
            MenuItem::Submenu {
                label,
                enabled,
                items,
                ..
            } => MenuValue::Submenu {
                label,
                enabled,
                items: menu_value(items),
            },
        })
        .collect()
}

fn pick_value(pick: Pick) -> serde_json::Value {
    match pick {
        Pick::One(id) => serde_json::json!({ "one": id }),
        Pick::None => serde_json::json!("none"),
        Pick::Many(n) => serde_json::json!({ "many": n }),
        Pick::Disabled => serde_json::json!("disabled"),
    }
}

fn pick_of(value: &serde_json::Value) -> Result<Pick, String> {
    if let Some(id) = value.get("one").and_then(serde_json::Value::as_u64) {
        return Ok(Pick::One(id as NodeId));
    }
    if let Some(n) = value.get("many").and_then(serde_json::Value::as_u64) {
        return Ok(Pick::Many(n as usize));
    }
    match value.as_str() {
        Some("none") => Ok(Pick::None),
        Some("disabled") => Ok(Pick::Disabled),
        _ => Err(format!("the host answered oddly: {value}")),
    }
}

/// What `model` answers of a host's part of `step` (a query
/// [`TestStep`], or a [`TestStep::Scene`] question about the model):
/// `None` for what only the platform's views answer (where a view is, the
/// viewport, an input's text, animations, a dialog's buttons). The web's
/// page answers its agent's questions so.
pub fn answer(model: &Model, step: &TestStep) -> Option<Result<serde_json::Value, String>> {
    use serde_json::{Value, to_value};
    let json = |r: Result<Value, serde_json::Error>| r.map_err(|e| e.to_string());
    Some(match step {
        TestStep::Texts => model.texts().map(Value::from),
        TestStep::Count { selector } => model.count(selector).map(Value::from),
        TestStep::Shows { selector } => model.matches(selector).map(Value::from),
        TestStep::Enabled { selector } => model.enabled(selector).map(Value::from),
        TestStep::SpanStyle { selector } => {
            model.span_style(selector).and_then(|s| json(to_value(s)))
        }
        TestStep::ViewStyle { selector } => {
            model.view_style(selector).and_then(|s| json(to_value(s)))
        }
        TestStep::Layout { selector } => model.layout(selector).and_then(|l| json(to_value(l))),
        TestStep::Accessibility { selector } => model
            .accessibility(selector.as_deref())
            .and_then(|a| json(to_value(a))),
        TestStep::Dialogs => model.dialogs().and_then(|d| json(to_value(d))),
        TestStep::PendingDialog => model.pending_dialog().and_then(|d| json(to_value(d))),
        TestStep::Scene { query } => match query {
            SceneQuery::Activity => model.activity().map(|a| {
                serde_json::json!({
                    "batches": a.batches,
                    "since_last_ms": a.since_last.map(|d| d.as_secs_f64() * 1000.0),
                })
            }),
            SceneQuery::TakeErrors => model.take_errors().map(Value::from),
            SceneQuery::InputValueText { selector } => {
                model.input_value_text(selector).map(Value::from)
            }
            SceneQuery::Pick { selector, target } => model.pick(selector, *target).map(pick_value),
            SceneQuery::ScrollAncestors { id } => {
                model.scroll_ancestors(*id).and_then(|a| json(to_value(a)))
            }
            SceneQuery::DragTakers { id } => model.drag_takers(*id).map(Value::from),
            SceneQuery::LongPressDelay { id } => model.long_press_delay(*id).map(Value::from),
            SceneQuery::Horizontal { id } => model.horizontal(*id).map(Value::from),
            SceneQuery::InputId { selector } => model.input_id(selector).map(Value::from),
            SceneQuery::Answered => model.answered().map(|()| Value::Null),
            SceneQuery::Menu => model.menu().and_then(|m| json(to_value(m.map(menu_value)))),
            SceneQuery::MenuClosed => model.menu_closed().map(|()| Value::Null),
            SceneQuery::Clipboard => Ok(Value::from(model.clipboard_text())),
            SceneQuery::Storage => json(to_value(model.storage_entries())),
            SceneQuery::SetViewport { width, height } => model
                .set_viewport(Size::new(Points(*width), Points(*height)))
                .map(|()| Value::Null),
            SceneQuery::Span { id } => model.span(*id).and_then(|s| json(to_value(s))),
            SceneQuery::CanvasNode { selector } => {
                model.canvas_node(selector).and_then(|n| json(to_value(n)))
            }
            SceneQuery::MatchInside { selector, id } => {
                model.match_inside(selector, *id).map(Value::from)
            }
            SceneQuery::Clock { change } => model.move_clock(*change).map(|()| Value::Null),
            SceneQuery::HostSend { name, data } => model
                .send_host_event(name, data.clone())
                .map(|()| Value::Null),
            SceneQuery::OpenedUrls => Ok(Value::from(model.opened_urls())),
            SceneQuery::Bounds { .. }
            | SceneQuery::TextBounds { .. }
            | SceneQuery::Viewport
            | SceneQuery::InputText { .. }
            | SceneQuery::Animating
            | SceneQuery::DialogPoint { .. } => return None,
        },
        _ => return None,
    })
}

/// A host's model asked about through the host ([`SceneQuery`]): the web's
/// agent, which runs in `nsh`, sees the page's app so.
pub struct RemoteScene {
    ask: Box<dyn Fn(TestStep) -> Result<serde_json::Value, String> + Send + Sync>,
    /// The app runs on a manual clock ([`RemoteScene::with_manual_clock`]).
    manual_clock: bool,
}

impl RemoteScene {
    /// Asks through `ask`, which takes a step on the host and gives its
    /// value.
    pub fn new(
        ask: impl Fn(TestStep) -> Result<serde_json::Value, String> + Send + Sync + 'static,
    ) -> Self {
        RemoteScene {
            ask: Box::new(ask),
            manual_clock: false,
        }
    }

    /// The app runs on a manual clock (the test's environment says so):
    /// the agent moves it as time passes in a step and in a wait.
    pub fn with_manual_clock(mut self, manual: bool) -> Self {
        self.manual_clock = manual;
        self
    }

    fn query<T: serde::de::DeserializeOwned>(&self, query: SceneQuery) -> Result<T, String> {
        self.get(TestStep::Scene { query })
    }

    fn get<T: serde::de::DeserializeOwned>(&self, step: TestStep) -> Result<T, String> {
        let value = (self.ask)(step)?;
        serde_json::from_value(value).map_err(|e| format!("the host answered oddly: {e}"))
    }
}

impl Scene for RemoteScene {
    fn input_value_text(&self, selector: &str) -> Result<Option<String>, String> {
        self.query(SceneQuery::InputValueText {
            selector: selector.into(),
        })
    }
    fn canvas_node(&self, selector: &str) -> Result<Option<(NodeId, Point<Points>)>, String> {
        self.query(SceneQuery::CanvasNode {
            selector: selector.into(),
        })
    }
    fn match_inside(&self, selector: &str, id: NodeId) -> Result<Option<NodeId>, String> {
        self.query(SceneQuery::MatchInside {
            selector: selector.into(),
            id,
        })
    }
    fn activity(&self) -> Result<Activity, String> {
        #[derive(serde::Deserialize)]
        struct Wire {
            batches: u64,
            since_last_ms: Option<f64>,
        }
        let wire: Wire = self.query(SceneQuery::Activity)?;
        Ok(Activity {
            batches: wire.batches,
            since_last: wire
                .since_last_ms
                .map(|ms| Duration::from_secs_f64(ms.max(0.0) / 1000.0)),
        })
    }
    fn take_errors(&self) -> Result<Vec<String>, String> {
        self.query(SceneQuery::TakeErrors)
    }
    fn pick(&self, selector: &str, target: PickTarget) -> Result<Pick, String> {
        let value: serde_json::Value = self.query(SceneQuery::Pick {
            selector: selector.into(),
            target,
        })?;
        pick_of(&value)
    }
    fn scroll_ancestors(&self, id: NodeId) -> Result<Vec<(NodeId, bool)>, String> {
        self.query(SceneQuery::ScrollAncestors { id })
    }
    fn drag_takers(&self, id: NodeId) -> Result<Vec<NodeId>, String> {
        self.query(SceneQuery::DragTakers { id })
    }
    fn long_press_delay(&self, id: NodeId) -> Result<Option<f32>, String> {
        self.query(SceneQuery::LongPressDelay { id })
    }
    fn horizontal(&self, id: NodeId) -> Result<bool, String> {
        self.query(SceneQuery::Horizontal { id })
    }
    fn texts(&self) -> Result<Vec<String>, String> {
        self.get(TestStep::Texts)
    }
    fn count(&self, selector: &str) -> Result<usize, String> {
        self.get(TestStep::Count {
            selector: selector.into(),
        })
    }
    fn matches(&self, selector: &str) -> Result<bool, String> {
        self.get(TestStep::Shows {
            selector: selector.into(),
        })
    }
    fn enabled(&self, selector: &str) -> Result<bool, String> {
        self.get(TestStep::Enabled {
            selector: selector.into(),
        })
    }
    fn span_style(&self, selector: &str) -> Result<SpanStyle, String> {
        self.get(TestStep::SpanStyle {
            selector: selector.into(),
        })
    }
    fn view_style(&self, selector: &str) -> Result<Option<ViewStyle>, String> {
        self.get(TestStep::ViewStyle {
            selector: selector.into(),
        })
    }
    fn layout(&self, selector: &str) -> Result<Option<ViewLayout>, String> {
        self.get(TestStep::Layout {
            selector: selector.into(),
        })
    }
    fn accessibility(&self, selector: Option<&str>) -> Result<Option<AccessibilityNode>, String> {
        self.get(TestStep::Accessibility {
            selector: selector.map(Into::into),
        })
    }
    fn input_id(&self, selector: &str) -> Result<Option<NodeId>, String> {
        self.query(SceneQuery::InputId {
            selector: selector.into(),
        })
    }
    fn dialogs(&self) -> Result<Vec<nsh_core::Dialog>, String> {
        self.get(TestStep::Dialogs)
    }
    fn pending_dialog(&self) -> Result<Option<nsh_core::Dialog>, String> {
        self.get(TestStep::PendingDialog)
    }
    fn answered(&self) -> Result<(), String> {
        self.query::<serde_json::Value>(SceneQuery::Answered)
            .map(drop)
    }
    fn menu(&self) -> Result<Option<Vec<nsh_core::desktop::MenuItem>>, String> {
        let menu: Option<Vec<MenuValue>> = self.query(SceneQuery::Menu)?;
        Ok(menu.map(|items| items.into_iter().map(MenuValue::into_item).collect()))
    }
    fn menu_closed(&self) -> Result<(), String> {
        self.query::<serde_json::Value>(SceneQuery::MenuClosed)
            .map(drop)
    }
    fn clipboard(&self) -> Result<Option<String>, String> {
        self.query(SceneQuery::Clipboard)
    }
    fn storage(&self) -> Result<std::collections::BTreeMap<String, String>, String> {
        self.query(SceneQuery::Storage)
    }
    fn set_viewport(&self, size: Size<Points>) -> Result<(), String> {
        self.query::<serde_json::Value>(SceneQuery::SetViewport {
            width: size.width.0,
            height: size.height.0,
        })
        .map(drop)
    }
    fn span(&self, id: NodeId) -> Result<Option<(NodeId, u32, u32)>, String> {
        self.query(SceneQuery::Span { id })
    }
    fn move_clock(&self, change: nsh_dev::protocol::ClockChange) -> Result<(), String> {
        self.query::<serde_json::Value>(SceneQuery::Clock { change })
            .map(drop)
    }
    fn manual_clock(&self) -> bool {
        self.manual_clock
    }
    fn send_host_event(&self, name: &str, data: serde_json::Value) -> Result<(), String> {
        self.query::<serde_json::Value>(SceneQuery::HostSend {
            name: name.into(),
            data,
        })
        .map(drop)
    }
    fn opened_urls(&self) -> Result<Vec<String>, String> {
        self.query(SceneQuery::OpenedUrls)
    }
}

/// A key the agent presses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// Return (Enter).
    Return,
    /// Deletes the character before the caret, or the selection.
    Backspace,
    /// Selects all the text of the focused input (Cmd+A, Ctrl+A).
    SelectAll,
}

/// The platform's part: where views are and the input that acts on them.
/// Called from the agent's thread; each call does its work on the host's
/// main thread and returns once it is done (input posted, not answered).
pub trait Native: Send + Sync {
    /// The view `id`'s unclipped bounds in the content of the window it is
    /// in (the main window, or one of the app's own), in points from its
    /// top-left. Mounted views outside a Scroll or the window retain their
    /// bounds so the agent can scroll them into view; `None` means the
    /// platform has no displayed view for this node.
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>>;
    /// How far scroll view `id` can still scroll along its axis
    /// (`horizontal`): back towards its start and on towards its end.
    /// `None` where the platform does not say: the agent's gestures find
    /// out.
    fn scroll_room(&self, id: NodeId, horizontal: bool) -> Option<(Points, Points)> {
        let _ = (id, horizontal);
        None
    }
    /// How far in from the start and the end of scroll view `id` along its
    /// axis (`horizontal`) something covers it while its content scrolls
    /// underneath, so a press there reaches what covers it: on iOS a bar
    /// the system draws over it (a transparent navigation bar at the top, a
    /// tab bar or a toolbar at the bottom) and what its content insets keep
    /// clear (the keyboard's room). The agent brings views out from under
    /// those edges. Zero where the platform draws nothing over its scroll
    /// views.
    fn scroll_insets(&self, id: NodeId, horizontal: bool) -> (Points, Points) {
        let _ = (id, horizontal);
        (Points(0.0), Points(0.0))
    }
    /// What a press at `at` (in the window's content, as
    /// [`Native::bounds`]) would reach in place of view `id`, a view the
    /// system draws over the app's (a navigation bar, a tab bar, a
    /// selection's edit menu), described for a failure; `None` when the
    /// press reaches the view, a view inside it or one around it, or the
    /// platform cannot tell. Asked before a step acts on a view, so it fails
    /// rather than pressing what covers it.
    fn covered(&self, id: NodeId, at: Point<Points>) -> Option<String> {
        let _ = (id, at);
        None
    }
    /// The window the pointer's input that follows acts in, until the next
    /// call: the one whose root node is `window` ([`nsh_core::ROOT_ID`]:
    /// the main window). The points [`Native::press`],
    /// [`Native::long_press`], [`Native::scroll`], [`Native::drag`],
    /// [`Native::hover`], [`Native::right_click`],
    /// [`Native::drag_and_hold`], [`Native::drop_files`] and
    /// [`Native::drop_at`] get are in that window's content, and their input
    /// goes to that window (which a press activates, as a click does). The
    /// agent names it before each step on a view. A platform without
    /// windows of the app's own acts in the main window only.
    fn target_window(&self, window: NodeId) -> Result<(), String> {
        if window == nsh_core::ROOT_ID {
            Ok(())
        } else {
            Err("this platform's test agent acts in the main window only: \
                 views in windows of the app's own cannot be reached yet"
                .into())
        }
    }
    /// The state of the window whose root node is `window`
    /// ([`nsh_core::ROOT_ID`]: the main window) as the platform reports it
    /// to the app now (`app.window(id).state()`); `None` when no such
    /// window is open.
    fn window_state(
        &self,
        window: NodeId,
    ) -> Result<Option<nsh_core::desktop::WindowState>, String> {
        let _ = window;
        Err("this platform's test agent reads no window state yet".into())
    }
    /// Presses the close button of the window whose root node is `window`
    /// as the user does (`app.window(id).pressClose()`), through the
    /// platform's own path: the window reports the press (reason
    /// `closeButton`) and closes when its `closeOnPress` lets it. An error
    /// when it has no close button.
    fn press_window_close(&self, window: NodeId) -> Result<(), String> {
        let _ = window;
        Err("this platform's test agent presses no window's close button yet".into())
    }
    /// A picture of the window whose root node is `window`
    /// ([`nsh_core::ROOT_ID`]: the main window), as [`Native::screenshot`]
    /// takes of the main one: PNG bytes of its content
    /// (`app.window(id).screenshot()`). An error when no such window is
    /// open.
    fn window_screenshot(&self, window: NodeId) -> Result<Vec<u8>, String> {
        if window == nsh_core::ROOT_ID {
            self.screenshot()
        } else {
            Err(
                "this platform's test agent takes no picture of windows of the app's own yet"
                    .into(),
            )
        }
    }
    /// Where the characters `start..end` (UTF-16 units) of text view
    /// `text` are on screen: the part on their first line, in the
    /// window's content as [`Native::bounds`] (`None`: not on screen, or
    /// the platform cannot say). A press there goes to the span they are
    /// (a nested text that takes presses), as the platform finds it.
    fn text_bounds(&self, text: NodeId, start: u32, end: u32) -> Option<Bounds<Points>> {
        let _ = (text, start, end);
        None
    }
    /// The size of the window's content, in points.
    fn viewport(&self) -> Size<Points>;
    /// A press (a click, a tap) at `at`.
    fn press(&self, at: Point<Points>);
    /// A press at `at` held for `hold`.
    fn long_press(&self, at: Point<Points>, hold: Duration);
    /// Scrolls what is at `at` by `delta` points (positive: down or right,
    /// towards the content's end), as a trackpad or a finger does.
    fn scroll(&self, at: Point<Points>, delta: Point<Points>);
    /// Drags from `from` to `to`: a finger (on a desktop, the mouse's
    /// button) down at `from`, resting there for `options.hold` ([`LANDING`]
    /// by default), moving along [`drag_path`] a display frame at a time and
    /// lifting at `to` at once, still moving, as a quick drag does. An agent
    /// that cannot honour `options` refuses them before putting a pointer
    /// down ([`refuse_custom_drag`]).
    fn drag(
        &self,
        from: Point<Points>,
        to: Point<Points>,
        options: DragOptions,
    ) -> Result<(), String>;
    /// The platform has a mouse ([`Native::hover`]): the desktops and the
    /// web; not the phones.
    fn mouse(&self) -> bool {
        false
    }
    /// Moves the mouse to `at`, without a button: what is under it is
    /// hovered. Only asked when the platform has a mouse
    /// ([`Native::mouse`]).
    fn hover(&self, at: Point<Points>) -> Result<(), String> {
        let _ = at;
        Err("this platform has no mouse".into())
    }
    /// The mouse's secondary button pressed and released at `at` (a
    /// context menu). Only asked when the platform has a mouse.
    fn right_click(&self, at: Point<Points>) -> Result<(), String> {
        let _ = at;
        Err("this platform has no mouse".into())
    }
    /// The input that has the keyboard focus, where the platform can tell:
    /// typing or a paste into it needs no press (one would move its caret).
    fn focused(&self) -> Option<NodeId> {
        None
    }
    /// Pastes `content` into the focused input, as the user's paste does
    /// with it on the clipboard (the system's clipboard stays as it was).
    fn paste(&self, content: &nsh_core::PasteEvent) -> Result<(), String> {
        let _ = content;
        Err(
            "pasting in tests is not supported on this platform yet: run the test headless, \
             or on macOS, iOS or the web"
                .into(),
        )
    }
    /// An input method composes `text` in the focused input: marked text
    /// at the caret, in place of what it composed; empty, the composition
    /// ends with nothing committed.
    fn compose(&self, text: &str) -> Result<(), String> {
        let _ = text;
        Err("`compose` runs headless and on macOS for now".into())
    }
    /// Chooses the action of the open context menu (`Menu.popup`) at the
    /// end of `path`: the labels of the submenus on the way, then its own.
    fn choose_menu_item(&self, path: &[String]) -> Result<(), String> {
        let _ = path;
        Err("this platform shows no context menus to choose from".into())
    }
    /// Closes the open context menu with nothing chosen.
    fn close_menu(&self) -> Result<(), String> {
        Err("this platform shows no context menus to close".into())
    }
    /// Whether a menu the system draws for one of the app's views is open
    /// (on iOS: a `MenuButton`'s, a `ContextMenu`'s or a header button's
    /// `UIMenu`; on Android: a `MenuButton`'s or a `ContextMenu`'s popup
    /// window), one the app's model does not hold: then
    /// [`Native::choose_menu_item`] chooses from it and
    /// [`Native::close_menu`] closes it.
    fn system_menu_open(&self) -> bool {
        false
    }
    /// Where a control the system draws for the app is on screen, one the
    /// app's views do not press (on iOS: a header button of
    /// `ios.headerRightItems`, by its `key` or its label; a `MenuButton`'s
    /// `UIButton`, by the `testID` of the view it covers or its label; on
    /// Android: a `MenuButton`'s button, named the same ways), in
    /// the window's content as [`Native::bounds`]: a press there reaches it
    /// as the user's does. `None` when the platform shows none so named.
    fn system_control(&self, name: SystemName<'_>) -> Option<Bounds<Points>> {
        let _ = name;
        None
    }
    /// Presses `keys`, a keystroke as `nsh/keymap` names it (`"mod+k"`;
    /// `mod` the platform's command key), on a hardware keyboard, in the
    /// window that has the keyboard focus (one of the app's own too): the
    /// app's shortcuts hear it, else what has the keyboard focus. Every
    /// platform's agent makes them; one that cannot refuses it.
    fn press_keys(&self, keys: &str) -> Result<(), String> {
        let _ = keys;
        Err("this platform's test agent presses no hardware keys: run the test headless".into())
    }
    /// Drags from `from` to `to` as [`Native::drag`] does, keeping the
    /// button down until [`Native::drop_at`].
    fn drag_and_hold(
        &self,
        from: Point<Points>,
        to: Point<Points>,
        options: DragOptions,
    ) -> Result<(), String> {
        let _ = (from, to, options);
        Err("`dragAndHold` runs headless, on Linux and on iOS for now".into())
    }
    /// Drops local files (`file:` URLs) at `at`, as a file manager's drag
    /// does.
    fn drop_files(&self, at: Point<Points>, uris: Vec<String>) -> Result<(), String> {
        let _ = (at, uris);
        Err("`dropFiles` runs headless, on Linux and on macOS for now".into())
    }
    /// Lets go of the button [`Native::drag_and_hold`] holds, at `at`.
    fn drop_at(&self, at: Point<Points>) -> Result<(), String> {
        let _ = at;
        Err("`drop` runs headless, on Linux and on iOS for now".into())
    }
    /// Holds modifier keys down (`down`) or lets go of them: the presses,
    /// drags and hovers until then carry them. One that cannot refuses it.
    fn hold_keys(&self, keys: &str, down: bool) -> Result<(), String> {
        let _ = keys;
        Err(crate::failure::unsupported_here(
            if down { "keyboard.down" } else { "keyboard.up" },
            "holding keys runs headless and on Linux for now",
        ))
    }
    /// Types `text` into the focused input, key by key.
    fn type_text(&self, text: &str);
    /// Presses `key`.
    fn key(&self, key: Key);
    /// Types a line for a test step, reporting a failed edit before the next key.
    fn try_type_text(&self, text: &str) -> Result<(), String> {
        self.type_text(text);
        Ok(())
    }
    /// Presses a key for a test step, reporting a failed edit.
    fn try_key(&self, key: Key) -> Result<(), String> {
        self.key(key);
        Ok(())
    }
    /// The text of input `id` as the platform holds it.
    fn input_text(&self, id: NodeId) -> Option<String>;
    /// Goes back as the user does (a back gesture, the back button,
    /// Escape): an error when the platform has none.
    fn back(&self) -> Result<(), String>;
    /// Goes forward in the browser's history: the web's; the other
    /// platforms have no forward.
    fn forward(&self) -> Result<(), String> {
        Err(crate::failure::web_only("forward"))
    }
    /// Answers the dialog the app shows now (the oldest): presses its
    /// button with the text `button`, or closes it without one.
    fn answer_dialog(&self, button: Option<&str>) -> Result<(), String>;
    /// Whether a native animation runs now that ends by itself: one that
    /// loops forever (a spinner) does not count, or no step would settle.
    fn animating(&self) -> bool;
    /// Whether a window of the app's own is still opening: made, but kept
    /// hidden until its first frame is in, which it waits for a moment at
    /// most. Input sent to it meanwhile is lost (AppKit gives a window that
    /// is not visible no mouse events), so a step waits for it to show as
    /// for an animation ([`Native::animating`]).
    fn opening(&self) -> bool {
        false
    }
    /// A picture of the window: PNG bytes, or UTF-8 Cell JSON on the terminal target.
    fn screenshot(&self) -> Result<Vec<u8>, String>;
    /// Makes the window `size` points.
    fn resize(&self, width: Points, height: Points) -> Result<(), String>;
    /// Switches the appearance the app sees.
    fn set_dark(&self, dark: bool) -> Result<(), String>;
    /// Closes the app: the host exits.
    fn quit(&self);
}

/// What covers a view under the edge of its scroll view that scrolling
/// does not bring it out from ([`Native::scroll_insets`]).
const UNDER_INSETS: &str = "what draws over the edge of its scroll view (a header, a bar, the keyboard), and \
     scrolling does not bring it out from under that";

/// What names a control the system draws for the app
/// ([`Native::system_control`]), as a step's selector does: `id:<key>` or
/// `label:<label>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SystemName<'a> {
    /// The id the app gave it (a header button's `key`).
    TestId(&'a str),
    /// Its accessibility label.
    Label(&'a str),
}

#[cfg(not(target_arch = "wasm32"))]
/// An [`Agent`] on a thread of its own, taking the steps handed to it one
/// after the other: what a host's dev client feeds the steps it gets.
pub struct Worker {
    steps: Mutex<std::sync::mpsc::Sender<(u64, TestStep)>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl Worker {
    /// Starts `agent`'s thread; each step's outcome goes to `done` with the
    /// step's id.
    pub fn spawn(
        agent: Agent,
        done: impl Fn(u64, StepOutcome) + Send + 'static,
    ) -> std::io::Result<Worker> {
        let (tx, rx) = std::sync::mpsc::channel::<(u64, TestStep)>();
        std::thread::Builder::new()
            .name("nsh-test-agent".into())
            .spawn(move || {
                for (id, step) in rx {
                    done(id, agent.take(step));
                }
            })?;
        Ok(Worker {
            steps: Mutex::new(tx),
        })
    }

    /// Hands step `id` to the agent; false when its thread is gone.
    pub fn take(&self, id: u64, step: TestStep) -> bool {
        self.steps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send((id, step))
            .is_ok()
    }
}

#[cfg(not(target_arch = "wasm32"))]
/// A dev host's test session: when the server says it runs one
/// ([`nsh_dev::DevEvent::Testing`]), it makes the app's [`Model`] and the
/// platform's [`Native`] (`start`, which attaches the model to the surface
/// before the first bundle comes) and takes the steps that follow on a
/// [`Worker`], answering each through the dev client.
pub struct Tester {
    start: Box<dyn Fn(std::sync::Arc<Model>) -> Box<dyn Native> + Send + Sync>,
    client: std::sync::OnceLock<std::sync::Weak<nsh_dev::DevClient>>,
    worker: Mutex<Option<Worker>>,
    /// The model of the session's app, once it started.
    model: Mutex<Option<std::sync::Arc<Model>>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl Tester {
    /// A host's tester; `start` runs on the dev client's thread.
    pub fn new(
        start: impl Fn(std::sync::Arc<Model>) -> Box<dyn Native> + Send + Sync + 'static,
    ) -> std::sync::Arc<Tester> {
        std::sync::Arc::new(Tester {
            start: Box::new(start),
            client: std::sync::OnceLock::new(),
            worker: Mutex::new(None),
            model: Mutex::new(None),
        })
    }

    /// The client that answers the steps (once it exists).
    pub fn set_client(&self, client: &std::sync::Arc<nsh_dev::DevClient>) {
        let _ = self.client.set(std::sync::Arc::downgrade(client));
    }

    /// Takes the test session's events (on the dev client's thread); gives
    /// back the others.
    pub fn event(&self, event: nsh_dev::DevEvent) -> Option<nsh_dev::DevEvent> {
        match event {
            nsh_dev::DevEvent::Testing => self.start(),
            nsh_dev::DevEvent::Step { id, step } => self.take(id, step),
            nsh_dev::DevEvent::TestSetup {
                storage,
                trace,
                environment,
            } => {
                if let Some(model) = self.model() {
                    let client = self.client.clone();
                    model.set_up(
                        storage,
                        trace,
                        environment,
                        Arc::new(move |message| {
                            let Some(client) = client.get().and_then(std::sync::Weak::upgrade)
                            else {
                                return;
                            };
                            match message {
                                Outgoing::Fetch(id, request) => client.fetch(id, request),
                                Outgoing::Cancel(id) => client.fetch_cancel(id),
                                Outgoing::Trace(items) => client.trace(items),
                            }
                        }),
                    );
                }
            }
            nsh_dev::DevEvent::Fetch { id, reply } => {
                if let Some(model) = self.model() {
                    model.fetch_reply(id, reply);
                }
            }
            other => return Some(other),
        }
        None
    }

    fn model(&self) -> Option<std::sync::Arc<Model>> {
        self.model.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn start(&self) {
        let mut worker = self.worker.lock().unwrap_or_else(|e| e.into_inner());
        if worker.is_some() {
            return;
        }
        let model = std::sync::Arc::new(Model::default());
        *self.model.lock().unwrap_or_else(|e| e.into_inner()) = Some(model.clone());
        let native = (self.start)(model.clone());
        let client = self.client.clone();
        let started = Worker::spawn(Agent::new(model, native), move |id, outcome| {
            if let Some(client) = client.get().and_then(std::sync::Weak::upgrade) {
                client.step_done(id, outcome);
            }
        });
        match started {
            Ok(started) => *worker = Some(started),
            Err(err) => log::error!("cannot start the test agent: {err}"),
        }
    }

    fn take(&self, id: u64, step: TestStep) {
        let taken = self
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|w| w.take(id, step));
        if !taken && let Some(client) = self.client.get().and_then(std::sync::Weak::upgrade) {
            client.step_done(
                id,
                StepOutcome::Failed {
                    message: "the host runs no test session".into(),
                },
            );
        }
    }
}

/// Whether `at` is inside `bounds` clear of its edges along the axis a
/// scroll view moves it (`horizontal`): of the outer tenth of each side,
/// 48 points at most. Across that axis only inside: scrolling cannot move
/// it there (a button at a row's end).
fn well_inside(bounds: &Bounds<Points>, at: Point<Points>, horizontal: bool) -> bool {
    let margin = |length: f32| (length * 0.1).min(48.0);
    let (margin_x, margin_y) = if horizontal {
        (margin(bounds.size.width.0), 0.0)
    } else {
        (0.0, margin(bounds.size.height.0))
    };
    let (x0, y0) = (bounds.origin.x.0 + margin_x, bounds.origin.y.0 + margin_y);
    let (x1, y1) = (
        bounds.origin.x.0 + bounds.size.width.0 - margin_x,
        bounds.origin.y.0 + bounds.size.height.0 - margin_y,
    );
    (x0..=x1).contains(&at.x.0) && (y0..=y1).contains(&at.y.0)
}

/// `bounds` of a scroll view less `insets`, what its content insets keep
/// clear at its start and its end along its axis (`horizontal`): the part
/// of it nothing draws over ([`Native::scroll_insets`]), empty when they
/// cover all of it.
fn inset_bounds(
    bounds: &Bounds<Points>,
    horizontal: bool,
    (start, end): (Points, Points),
) -> Bounds<Points> {
    let length = if horizontal {
        bounds.size.width.0
    } else {
        bounds.size.height.0
    };
    let start = start.0.clamp(0.0, length);
    let shown = (length - start - end.0.max(0.0)).max(0.0);
    let mut out = *bounds;
    if horizontal {
        out.origin.x = Points(bounds.origin.x.0 + start);
        out.size.width = Points(shown);
    } else {
        out.origin.y = Points(bounds.origin.y.0 + start);
        out.size.height = Points(shown);
    }
    out
}

/// The spot of a scroll view `extent` points long from `start` (along the
/// axis it scrolls) nearest `along` (a fraction of its length) that no
/// span of `covered` (in points along it) holds, a finger's margin clear of
/// each, within the middle 70% of it (where a gesture has room); as a
/// fraction of its length, `None` when no spot is clear.
fn clear_spot(start: f32, extent: f32, along: f32, covered: &[(f32, f32)]) -> Option<f32> {
    const MARGIN: f32 = 8.0;
    if extent <= 0.0 {
        return None;
    }
    let (lo, hi) = (start + extent * 0.15, start + extent * 0.85);
    let clear = |p: f32| {
        (lo..=hi).contains(&p)
            && covered
                .iter()
                .all(|&(from, to)| p <= from - MARGIN || p >= to + MARGIN)
    };
    let want = start + extent * along;
    // The nearest clear spot is `along` itself, an end of the range or
    // one just past a span.
    std::iter::once(want)
        .chain([lo, hi])
        .chain(
            covered
                .iter()
                .flat_map(|&(from, to)| [from - MARGIN, to + MARGIN]),
        )
        .filter(|&p| clear(p))
        .min_by(|a, b| (a - want).abs().total_cmp(&(b - want).abs()))
        .map(|p| (p - start) / extent)
}

/// Where along a scroll view a finger lands to scroll it, as a fraction of
/// its length, after `misses` gestures that moved nothing (`None`: every
/// spot was tried): its middle, then off the middle, for what scrolls by
/// itself there (a text area), as a user moves the finger: first a quarter
/// of the way from the edge the finger moves away from (the end when it
/// moves `to_start`), where it has the most room, so a gesture undone (a
/// fling back) costs the next ones no reach, then a quarter of the way
/// from the other.
fn anchor(misses: usize, to_start: bool) -> Option<f32> {
    let (roomy, other) = if to_start { (0.75, 0.25) } else { (0.25, 0.75) };
    [0.5, roomy, other].get(misses).copied()
}

/// Whether [`Agent::settled_unless_still`] can skip [`Agent::settled`]
/// because nothing changed since the last settled step: `settled` matches
/// `activity.batches`, the last batch arrived at least [`QUIET`] ago, and the
/// platform is not `changing` what shows by itself ([`Agent::changing`]: no
/// finite native animation runs, no window waits to show).
fn is_still(settled: Option<u64>, activity: Activity, changing: bool) -> bool {
    settled == Some(activity.batches)
        && activity.since_last.is_some_and(|since| since >= QUIET)
        && !changing
}

/// Takes test steps on a host's app ([`Model`], [`Native`]).
pub struct Agent {
    scene: std::sync::Arc<dyn Scene>,
    native: Box<dyn Native>,
    /// The window's size the scene was told last.
    viewport: Mutex<Option<Size<Points>>>,
    /// Where a `dragAndHold` left the pointer down.
    held: Mutex<Option<Point<Points>>>,
    /// The batches the app had applied when a step last ended with it quiet
    /// ([`Agent::settled`]): a step that looks for a view next finds the app
    /// as quiet as it left it when no batch came since.
    quiet: Mutex<Option<u64>>,
}

impl Agent {
    /// An agent on the app `scene` sees, acting through `native`.
    pub fn new(scene: std::sync::Arc<dyn Scene>, native: Box<dyn Native>) -> Agent {
        Agent {
            scene,
            native,
            viewport: Mutex::new(None),
            held: Mutex::new(None),
            quiet: Mutex::new(None),
        }
    }

    /// Takes `step`; blocks until it is done and the app is quiet.
    pub fn take(&self, step: TestStep) -> StepOutcome {
        match self.run(step) {
            Ok(value) => StepOutcome::Done { value },
            Err(message) => StepOutcome::Failed { message },
        }
    }

    fn run(&self, step: TestStep) -> Result<serde_json::Value, String> {
        use serde_json::Value;
        let done = |r: Result<(), String>| r.map(|()| Value::Null);
        // What is on screen depends on the window: the scene knows it before
        // it answers.
        if !matches!(step, TestStep::Scene { .. }) {
            self.sync_viewport()?;
        }
        match step {
            TestStep::Ready { timeout_ms } => done(self.ready(Duration::from_millis(timeout_ms))),
            TestStep::Press { selector } => done(self.press(&selector)),
            TestStep::LongPress { selector } => done(self.long_press(&selector)),
            TestStep::Type { selector, text } => done(self.type_text(&selector, &text)),
            TestStep::Submit { selector } => done(self.submit(&selector)),
            TestStep::Clear { selector } => done(self.clear(&selector)),
            TestStep::Scroll { selector, distance } => done(self.scroll(&selector, distance)),
            TestStep::Drag {
                selector,
                x,
                y,
                hold_ms,
            } => done(self.drag(&selector, x, y, DragOptions::from_ms(hold_ms)?)),
            TestStep::Hover { selector } => done(self.hover(&selector)),
            TestStep::RightClick { selector } => done(self.right_click(&selector)),
            TestStep::Paste {
                selector,
                text,
                html,
                files,
                uris,
            } => {
                let mut content = nsh_core::PasteEvent::new(text);
                content.html = html;
                content.files = files
                    .into_iter()
                    .map(|f| nsh_core::PastedFile::new(f.name, f.mime, f.data))
                    .collect();
                content.uris = uris;
                done(self.paste(&selector, &content))
            }
            TestStep::Menu => {
                let menu = self.scene.menu()?;
                serde_json::to_value(menu.map(|m| crate::menu::entries(&m)))
                    .map_err(|e| e.to_string())
            }
            TestStep::ChooseMenuItem { label } => done(self.choose_menu_item(&label)),
            TestStep::CloseMenu => done(self.close_menu()),
            TestStep::Clipboard => self.scene.clipboard().map(Value::from),
            TestStep::HostSend { name, data } => done(
                self.scene
                    .send_host_event(&name, data)
                    .and_then(|()| self.settled()),
            ),
            TestStep::OpenedUrls => self.scene.opened_urls().map(Value::from),
            TestStep::DragAndHold {
                selector,
                x,
                y,
                hold_ms,
            } => done(self.drag_and_hold(&selector, x, y, DragOptions::from_ms(hold_ms)?)),
            TestStep::Drop => done(self.drop_held()),
            TestStep::Compose { selector, text } => done(self.compose(&selector, &text)),
            TestStep::DropFiles { selector, uris } => done(
                self.find(&selector, "view", PickTarget::View)
                    .and_then(|(_, at)| self.native.drop_files(at, uris))
                    .and_then(|()| self.settled()),
            ),
            TestStep::HoldKeys { keys, down } => done(
                self.native
                    .hold_keys(&keys, down)
                    .and_then(|()| self.settled()),
            ),
            TestStep::PressKey { keys } => {
                done(self.native.press_keys(&keys).and_then(|()| self.settled()))
            }
            TestStep::Back => done(self.native.back().and_then(|()| self.settled())),
            TestStep::Forward => done(self.native.forward().and_then(|()| self.settled())),
            TestStep::Wait { ms } => {
                self.clear_quiet();
                std::thread::sleep(Duration::from_millis(ms));
                done(self.check())
            }
            TestStep::Clock { change } => {
                done(self.scene.move_clock(change).and_then(|()| self.settled()))
            }
            TestStep::WaitFor {
                selector,
                timeout_ms,
                gone,
            } => done(self.wait_for(&selector, Duration::from_millis(timeout_ms), gone)),
            TestStep::NextChange { timeout_ms } => {
                self.clear_quiet();
                let seen = self.scene.activity()?.batches;
                self.scene
                    .wait_for_batch(seen, Duration::from_millis(timeout_ms));
                done(self.check())
            }
            TestStep::NextFrame { ms } => {
                self.clear_quiet();
                let seen = self.scene.activity()?.batches;
                let left = Duration::from_millis(ms);
                if self.scene.manual_clock() {
                    self.next_frame(seen, left)?;
                } else {
                    self.scene.wait_for_batch(seen, left);
                }
                done(self.check())
            }
            TestStep::Texts => Ok(Value::from(self.scene.texts()?)),
            TestStep::Count { selector } => Ok(Value::from(self.scene.count(&selector)?)),
            TestStep::Shows { selector } => Ok(Value::from(self.scene.matches(&selector)?)),
            TestStep::Enabled { selector } => Ok(Value::from(self.scene.enabled(&selector)?)),
            TestStep::SpanStyle { selector } => {
                serde_json::to_value(self.scene.span_style(&selector)?).map_err(|e| e.to_string())
            }
            TestStep::ViewStyle { selector } => {
                serde_json::to_value(self.scene.view_style(&selector)?).map_err(|e| e.to_string())
            }
            TestStep::Layout { selector } => {
                serde_json::to_value(self.scene.layout(&selector)?).map_err(|e| e.to_string())
            }
            TestStep::Accessibility { selector } => {
                serde_json::to_value(self.scene.accessibility(selector.as_deref())?)
                    .map_err(|e| e.to_string())
            }
            TestStep::Value { selector } => {
                if let Some(text) = self.scene.input_value_text(&selector)? {
                    return Ok(Value::from(text));
                }
                let id = self.scene.input_id(&selector)?;
                Ok(id
                    .and_then(|id| self.native.input_text(id))
                    .map_or(Value::Null, Value::from))
            }
            TestStep::Dialogs => {
                serde_json::to_value(self.scene.dialogs()?).map_err(|e| e.to_string())
            }
            TestStep::PendingDialog => {
                serde_json::to_value(self.scene.pending_dialog()?).map_err(|e| e.to_string())
            }
            TestStep::AnswerDialog { button } => done(self.answer_dialog(button.as_deref())),
            TestStep::Screenshot => {
                use base64::Engine as _;
                let png = self.native.screenshot()?;
                Ok(Value::from(
                    base64::engine::general_purpose::STANDARD.encode(png),
                ))
            }
            TestStep::SetViewport { width, height } => done(
                self.native
                    .resize(Points(width), Points(height))
                    .and_then(|()| self.settled()),
            ),
            TestStep::SetColorScheme { dark } => {
                done(self.native.set_dark(dark).and_then(|()| self.settled()))
            }
            TestStep::Quit => {
                let released = self.release_held().map(|_| ());
                self.native.quit();
                done(released)
            }
            TestStep::WindowIds => Ok(serde_json::json!(self.scene.window_ids()?)),
            TestStep::WindowState { id } => match self.scene.window_root(&id)? {
                Some(root) => Ok(self
                    .native
                    .window_state(root)?
                    .map_or(Value::Null, |s| crate::window_json::to_json(&s))),
                None => Ok(Value::Null),
            },
            TestStep::PressWindowClose { id } => {
                let root = self
                    .scene
                    .window_root(&id)?
                    .ok_or_else(|| format!("no window {id:?} is open"))?;
                done(
                    self.native
                        .press_window_close(root)
                        .map_err(|e| format!("cannot press the close button of window {id:?}: {e}"))
                        .and_then(|()| self.settled()),
                )
            }
            TestStep::WindowScreenshot { id } => {
                use base64::Engine as _;
                let root = self
                    .scene
                    .window_root(&id)?
                    .ok_or_else(|| format!("no window {id:?} is open"))?;
                let png = self
                    .native
                    .window_screenshot(root)
                    .map_err(|e| format!("cannot take a picture of window {id:?}: {e}"))?;
                Ok(Value::from(
                    base64::engine::general_purpose::STANDARD.encode(png),
                ))
            }
            TestStep::Scene { query } => self.scene_query(query),
        }
    }

    /// Tells the scene the host surface's size and each app window's when
    /// they changed.
    fn sync_viewport(&self) -> Result<(), String> {
        let size = self.native.viewport();
        {
            let mut told = self.viewport.lock().unwrap_or_else(|e| e.into_inner());
            if *told != Some(size) {
                self.scene.set_viewport(size)?;
                *told = Some(size);
            }
        }
        // The app's windows are not the host surface: clip each to the
        // content size the platform reports, so what is on screen in it is
        // found by selectors and reads as shown.
        for id in self.scene.window_ids()? {
            let Some(root) = self.scene.window_root(&id)? else {
                continue;
            };
            // A platform that reads no window state, or has not sized this
            // window yet (Linux before GTK maps it), keeps the host
            // surface's clip (its own window is the surface).
            if let Ok(Some(state)) = self.native.window_state(root)
                && !state.content_bounds.is_empty()
            {
                self.scene
                    .set_window_size(root, state.content_bounds.size)?;
            }
        }
        Ok(())
    }

    /// Answers an agent elsewhere with this one's scene and platform.
    fn scene_query(&self, query: SceneQuery) -> Result<serde_json::Value, String> {
        use serde_json::{Value, to_value};
        let json = |r: Result<Value, serde_json::Error>| r.map_err(|e| e.to_string());
        let scene = &*self.scene;
        match query {
            SceneQuery::Activity => scene.activity().map(|a| {
                serde_json::json!({
                    "batches": a.batches,
                    "since_last_ms": a.since_last.map(|d| d.as_secs_f64() * 1000.0),
                })
            }),
            SceneQuery::TakeErrors => scene.take_errors().map(Value::from),
            SceneQuery::InputValueText { selector } => {
                scene.input_value_text(&selector).map(Value::from)
            }
            SceneQuery::Pick { selector, target } => scene.pick(&selector, target).map(pick_value),
            SceneQuery::ScrollAncestors { id } => {
                scene.scroll_ancestors(id).and_then(|a| json(to_value(a)))
            }
            SceneQuery::DragTakers { id } => scene.drag_takers(id).map(Value::from),
            SceneQuery::LongPressDelay { id } => scene.long_press_delay(id).map(Value::from),
            SceneQuery::Horizontal { id } => scene.horizontal(id).map(Value::from),
            SceneQuery::InputId { selector } => scene.input_id(&selector).map(Value::from),
            SceneQuery::Answered => scene.answered().map(|()| Value::Null),
            SceneQuery::Menu => scene.menu().and_then(|m| json(to_value(m.map(menu_value)))),
            SceneQuery::MenuClosed => scene.menu_closed().map(|()| Value::Null),
            SceneQuery::Clipboard => scene.clipboard().map(Value::from),
            SceneQuery::Storage => scene.storage().and_then(|e| json(to_value(e))),
            SceneQuery::SetViewport { width, height } => scene
                .set_viewport(Size::new(Points(width), Points(height)))
                .map(|()| Value::Null),
            SceneQuery::Span { id } => scene.span(id).and_then(|s| json(to_value(s))),
            SceneQuery::CanvasNode { selector } => {
                scene.canvas_node(&selector).and_then(|n| json(to_value(n)))
            }
            SceneQuery::MatchInside { selector, id } => {
                scene.match_inside(&selector, id).map(Value::from)
            }
            SceneQuery::Clock { change } => scene.move_clock(change).map(|()| Value::Null),
            SceneQuery::HostSend { name, data } => {
                scene.send_host_event(&name, data).map(|()| Value::Null)
            }
            SceneQuery::OpenedUrls => scene.opened_urls().map(Value::from),
            SceneQuery::Bounds { id } => {
                json(to_value(self.native.bounds(id).map(|b| {
                    [b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0]
                })))
            }
            SceneQuery::TextBounds { id, start, end } => {
                json(to_value(self.native.text_bounds(id, start, end).map(|b| {
                    [b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0]
                })))
            }
            SceneQuery::Viewport => {
                let v = self.native.viewport();
                json(to_value([v.width.0, v.height.0]))
            }
            SceneQuery::InputText { id } => {
                Ok(self.native.input_text(id).map_or(Value::Null, Value::from))
            }
            SceneQuery::Animating => Ok(Value::from(self.native.animating())),
            SceneQuery::DialogPoint { .. } => {
                Err("this host answers dialogs itself (`AnswerDialog`)".into())
            }
        }
    }

    /// Waits for the first render, `timeout` at most, then until the app
    /// is quiet.
    fn ready(&self, timeout: Duration) -> Result<(), String> {
        self.scene.wait_for_batch(0, timeout);
        let rendered = self.scene.activity()?.batches > 0;
        self.check()?;
        if !rendered {
            return Err(crate::failure::rendered_nothing(timeout));
        }
        self.settled()
    }

    /// The one view `pick` gave for `selector` (from [`Self::find`]).
    fn picked(&self, pick: Pick, selector: &str, what: &str) -> Result<NodeId, String> {
        match pick {
            Pick::One(id) => Ok(id),
            Pick::None => Err(format!(
                "{}; {}",
                crate::failure::not_found(what, selector),
                self.on_screen()
            )),
            Pick::Many(n) => Err(format!(
                "`{selector}` matches {n} {what}s: say which (`{selector} >> nth=0`), or look inside \
                 a view around it (`id:list >> {selector}`)"
            )),
            Pick::Disabled => Err(format!(
                "{}; {}",
                crate::failure::disabled(selector, what),
                self.on_screen()
            )),
        }
    }

    /// The view `selector` names as `pick` finds it in the model, and the
    /// middle of it on screen.
    fn find(
        &self,
        selector: &str,
        what: &str,
        target: PickTarget,
    ) -> Result<(NodeId, Point<Points>), String> {
        Selector::parse(selector)?;
        self.settled_unless_still()?;
        let picked = self.scene.pick(selector, target)?;
        let id = self.picked(picked, selector, what)?;
        // The pointer acts in the window the view is in.
        self.native.target_window(self.scene.window_of(id)?)?;
        let (view, at) = self.locate(id, selector, target)?;
        // What the system draws over the app (a header it scrolls under)
        // would take the press: the step fails rather than pressing it.
        if let Some(cover) = self.native.covered(view, at) {
            return Err(format!(
                "{}; {}",
                crate::failure::covered(selector, &cover),
                self.on_screen()
            ));
        }
        Ok((id, at))
    }

    /// Where on screen a step acts on view `id`, which `selector` names,
    /// scrolled into view first, and the view at that spot: `id`, the match
    /// inside it a press lands on, its text or its canvas.
    fn locate(
        &self,
        id: NodeId,
        selector: &str,
        target: PickTarget,
    ) -> Result<(NodeId, Point<Points>), String> {
        if let Some((canvas, center)) = self.scene.canvas_node(selector)? {
            return Ok((
                canvas,
                self.scroll_point_into_view(canvas, selector, Some(center))?,
            ));
        }
        let Some((text, start, end)) = self.scene.span(id)? else {
            // A press on what the selector matches inside the view that
            // takes it (a cell's text in a row) lands on that match, as a
            // finger taps the text it reads.
            let pressing = matches!(target, PickTarget::Pressable | PickTarget::LongPressable);
            let inner = if pressing {
                self.scene.match_inside(selector, id)?
            } else {
                None
            };
            let view = match inner {
                Some(inner) if self.native.bounds(inner).is_some() => inner,
                _ => id,
            };
            let at = self.scroll_into_view(view, selector)?;
            if matches!(target, PickTarget::Input) {
                // Scrolling can bring the field underneath another view.
                self.scene.pick(selector, target)?;
            }
            return Ok((view, at));
        };
        // A span of a text: its text view comes into view, then the finger
        // goes on its characters.
        self.scroll_into_view(text, selector)?;
        let at = self
            .native
            .text_bounds(text, start, end)
            .filter(|b| !b.is_empty())
            .ok_or_else(|| {
                format!(
                    "`{selector}` is a span of a text, and this platform does not say where its \
                     characters are; {}",
                    self.on_screen()
                )
            })?;
        Ok((text, at.center()))
    }

    /// The middle of view `id` on screen, scrolled into view first when it
    /// is not: the innermost scroll view around it that hides it scrolls it
    /// towards its own middle, a gesture at a time, as a user would.
    fn scroll_into_view(&self, id: NodeId, selector: &str) -> Result<Point<Points>, String> {
        self.scroll_point_into_view(id, selector, None)
    }

    /// Brings a point within a view into view (its center when `local`
    /// is `None`), retaining a canvas node's position through scrolling.
    fn scroll_point_into_view(
        &self,
        id: NodeId,
        selector: &str,
        local: Option<Point<Points>>,
    ) -> Result<Point<Points>, String> {
        let (at, scrolled) = self.bring_into_view(id, selector, local)?;
        if !scrolled {
            return Ok(at);
        }
        // What the scrolling brought (rows bound, images decoded) lands
        // before the step acts, once: between the gestures only the view's
        // own movement is waited for ([`Agent::stopped`]).
        self.settled()?;
        Ok(self
            .native
            .bounds(id)
            .map_or(at, |b| local.map_or(b.center(), |p| b.origin + p)))
    }

    /// [`Agent::scroll_into_view`]'s gestures: the view's middle, and
    /// whether a gesture moved anything.
    fn bring_into_view(
        &self,
        id: NodeId,
        selector: &str,
        local: Option<Point<Points>>,
    ) -> Result<(Point<Points>, bool), String> {
        let not_on_screen = || {
            format!(
                "`{selector}` is not on screen (it has no native view); {}",
                self.on_screen()
            )
        };
        let scrollers = self.scene.scroll_ancestors(id)?;
        // The window the view is in: a window of the app's own is not the
        // host surface, and its points are its own content's.
        let window_root = self.scene.window_of(id)?;
        let window = self
            .scene
            .window_size(window_root)
            .unwrap_or_else(|| self.native.viewport());
        let window = Bounds::new(Point::new(Points(0.0), Points(0.0)), window);
        // Where a scroll view shows its content: its bounds clear of what
        // draws over its edges ([`Native::scroll_insets`]). A view under
        // those is hidden as one outside it is, and a finger scrolling it
        // lands clear of them (a press there reaches the bar over it).
        let shown = |scroller: NodeId, horizontal: bool| {
            let b = self.native.bounds(scroller)?;
            Some(inset_bounds(
                &b,
                horizontal,
                self.native.scroll_insets(scroller, horizontal),
            ))
        };
        // The view's spot once no gesture brings it nearer: in the window
        // and out from under the edges of its scroll views.
        let arrived = |at: Point<Points>, scrolled: bool| {
            if !window.contains(&at) {
                return Err(not_on_screen());
            }
            let under = scrollers.iter().any(|&(scroller, horizontal)| {
                self.native.bounds(scroller).is_some_and(|b| {
                    b.contains(&at) && shown(scroller, horizontal).is_some_and(|s| !s.contains(&at))
                })
            });
            if under {
                return Err(format!(
                    "{}; {}",
                    crate::failure::covered(selector, UNDER_INSETS),
                    self.on_screen()
                ));
            }
            Ok((at, scrolled))
        };
        let mut before: Option<Point<Points>> = None;
        // The gestures that moved nothing: each moves the finger elsewhere
        // ([`anchor`]).
        let mut misses = 0;
        for _ in 0..SCROLLS_INTO_VIEW {
            let bounds = self.native.bounds(id).ok_or_else(not_on_screen)?;
            let at = local.map_or(bounds.center(), |p| bounds.origin + p);
            if let Some(b) = before
                && (b.x.0 - at.x.0).abs() < 1.0
                && (b.y.0 - at.y.0).abs() < 1.0
            {
                misses += 1;
            }
            // A scroll view already at the end a gesture would move it
            // towards brings nothing nearer: the finger would pull it past
            // that end (a pull to refresh, a page sheet following the drag
            // down and closing).
            let can_move = |scroller: NodeId, horizontal: bool, b: &Bounds<Points>| {
                let back = if horizontal {
                    at.x.0 < b.center().x.0
                } else {
                    at.y.0 < b.center().y.0
                };
                self.native
                    .scroll_room(scroller, horizontal)
                    .is_none_or(|(start, end)| if back { start.0 } else { end.0 } >= 1.0)
            };
            // The innermost scroll view whose shown part leaves the middle
            // out, or near its edge (where a finger does not press and bars,
            // the home indicator and fades sit), else the outermost one
            // when the window does.
            let hiding = scrollers.iter().find_map(|&(scroller, horizontal)| {
                let b = shown(scroller, horizontal)?;
                (!well_inside(&b, at, horizontal) && can_move(scroller, horizontal, &b))
                    .then_some((scroller, horizontal, b))
            });
            let hiding = hiding.or_else(|| {
                let &(s, h) = scrollers.last()?;
                (!well_inside(&window, at, h)).then_some(())?;
                let b = shown(s, h)?;
                can_move(s, h, &b).then_some((s, h, b))
            });
            let Some((scroll, horizontal, scroller)) = hiding else {
                return arrived(at, before.is_some());
            };
            let length = |b: &Bounds<Points>| {
                if horizontal {
                    b.size.width.0
                } else {
                    b.size.height.0
                }
            };
            if length(&scroller) < 1.0
                && self
                    .native
                    .bounds(scroll)
                    .is_some_and(|b| length(&b) >= 1.0)
            {
                // Its insets cover it from end to end (a keyboard over a
                // short scroll view): no finger reaches it. One that is
                // that small itself goes on as before.
                return Err(format!(
                    "{}; {}",
                    crate::failure::covered(selector, UNDER_INSETS),
                    self.on_screen()
                ));
            }
            // The finger moves towards the start when the content moves
            // towards its end.
            let to_start = if horizontal {
                at.x.0 > scroller.center().x.0
            } else {
                at.y.0 > scroller.center().y.0
            };
            let Some(along) = anchor(misses, to_start) else {
                // No gesture moves it any more (its scroll view's end): it
                // is pressed where it is when it shows.
                return arrived(at, before.is_some());
            };
            let along = self.landing(scroll, &scroller, horizontal, along)?;
            let middle = if horizontal {
                point(
                    scroller.origin.x + scroller.size.width * along,
                    scroller.center().y,
                )
            } else {
                point(
                    scroller.center().x,
                    scroller.origin.y + scroller.size.height * along,
                )
            };
            let (distance, extent) = if horizontal {
                (at.x.0 - middle.x.0, scroller.size.width.0)
            } else {
                (at.y.0 - middle.y.0, scroller.size.height.0)
            };
            // A finger dragging it stays inside it: as far as the edge it
            // moves towards (the start when the content moves towards its
            // end) less a tenth, a tenth at least.
            let toward = if distance > 0.0 { along } else { 1.0 - along };
            let room = extent * (toward - 0.1).max(0.1);
            let mut step = distance.clamp(-room, room);
            // Do not cross the content's edge within this gesture either:
            // its remainder can pull a sheet down or start a refresh.
            if let Some((start, end)) = self.native.scroll_room(scroll, horizontal) {
                step = step.clamp(-start.0, end.0);
            }
            let delta = if horizontal {
                Point::new(Points(step), Points(0.0))
            } else {
                Point::new(Points(0.0), Points(step))
            };
            self.clear_quiet();
            self.native.scroll(middle, delta);
            self.stopped(id)?;
            before = Some(at);
        }
        Err(format!(
            "`{selector}` did not come into view; {}",
            self.on_screen()
        ))
    }

    /// Where along scroll view `id` (at `bounds`) a finger lands to scroll
    /// it, as a fraction of its length, nearest `along`: on a spot clear of
    /// the views inside that take a drag themselves
    /// ([`Scene::drag_takers`]), as a user puts the finger on the page and
    /// not on a slider or a drawing area. On one of those the app's
    /// responder decides, a moment later, whether the scroll view keeps the
    /// gesture: it may scroll, stop half way or not move at all. `along`
    /// where no spot is clear, and on a platform with a mouse
    /// ([`Native::mouse`]), whose wheel scrolls the scroll view wherever it
    /// is.
    fn landing(
        &self,
        id: NodeId,
        bounds: &Bounds<Points>,
        horizontal: bool,
        along: f32,
    ) -> Result<f32, String> {
        if self.native.mouse() {
            return Ok(along);
        }
        let takers = self.scene.drag_takers(id)?;
        if takers.is_empty() {
            return Ok(along);
        }
        // Along the scroll view's length, and across it, where the finger
        // moves: its middle.
        let axes = |b: &Bounds<Points>| {
            if horizontal {
                (
                    (b.origin.x.0, b.size.width.0),
                    (b.origin.y.0, b.size.height.0),
                )
            } else {
                (
                    (b.origin.y.0, b.size.height.0),
                    (b.origin.x.0, b.size.width.0),
                )
            }
        };
        let ((start, extent), (across, across_extent)) = axes(bounds);
        let line = across + across_extent / 2.0;
        // What the takers cover of the finger's line.
        let covered: Vec<(f32, f32)> = takers
            .into_iter()
            .filter_map(|taker| self.native.bounds(taker))
            .filter_map(|b| {
                let ((from, length), (side, width)) = axes(&b);
                (side..=side + width)
                    .contains(&line)
                    .then_some((from, from + length))
            })
            .collect();
        Ok(clear_spot(start, extent, along, &covered).unwrap_or(along))
    }

    fn press(&self, selector: &str) -> Result<(), String> {
        let at = match self.find(selector, "pressable view", PickTarget::Pressable) {
            Ok((_, at)) => at,
            // Not one of the app's views on screen: a control the system
            // draws for it (a header button) may carry the name.
            Err(error) => self.system_control(selector).ok_or(error)?,
        };
        self.native.press(at);
        self.settled()
    }

    /// The middle of the control the system draws for the app that
    /// `selector` names alone (`id:<key>`, `label:<label>` or a bare name,
    /// as a test id, else a label), when the platform shows one.
    fn system_control(&self, selector: &str) -> Option<Point<Points>> {
        use crate::selector::{Matcher, TextMatch};
        let parsed = Selector::parse(selector).ok()?;
        let [part] = parsed.parts.as_slice() else {
            return None;
        };
        if part.nth.is_some() {
            return None;
        }
        let bounds = match &part.matcher {
            Matcher::TestId(id) => self.native.system_control(SystemName::TestId(id)),
            Matcher::Label(TextMatch::Exact(label)) => {
                self.native.system_control(SystemName::Label(label))
            }
            Matcher::Any(name) => self
                .native
                .system_control(SystemName::TestId(name))
                .or_else(|| self.native.system_control(SystemName::Label(name))),
            _ => None,
        }?;
        Some(bounds.center())
    }

    fn long_press(&self, selector: &str) -> Result<(), String> {
        let (id, at) = self.find(selector, "pressable view", PickTarget::LongPressable)?;
        let hold = self.scene.long_press_delay(id)?.map_or(LONG_PRESS, |ms| {
            Duration::from_secs_f64(f64::from(ms.max(0.0)) / 1000.0)
        });
        // A little past the delay, as a finger holds on.
        let hold = hold + Duration::from_millis(100);
        if !self.scene.manual_clock() {
            self.native.long_press(at, hold);
            return self.settled();
        }
        // The app's time passes while the finger rests, as headless: once
        // it has landed, the manual clock moves by the rest of the hold
        // (the timers of a hold the app keeps itself fire on the way).
        // The move is sent while the finger rests, so the engine takes it
        // between the touch's start and its end.
        let moved = std::thread::scope(|s| {
            s.spawn(|| self.native.long_press(at, hold));
            std::thread::sleep(LANDING);
            let ms = hold.saturating_sub(LANDING).as_millis() as u64;
            self.scene
                .move_clock(nsh_dev::protocol::ClockChange::RunFor { ms })
        });
        moved.and_then(|()| self.settled())
    }

    /// Focuses the input `selector` names by pressing it.
    fn focus(&self, selector: &str) -> Result<(), String> {
        let (id, at) = self.find(selector, "input", PickTarget::Input)?;
        self.native.press(at);
        self.settled()?;
        if let Some(focused) = self.native.focused()
            && focused != id
        {
            return Err(crate::failure::covered(
                selector,
                &format!("`view:{focused}`"),
            ));
        }
        Ok(())
    }

    fn type_text(&self, selector: &str, text: &str) -> Result<(), String> {
        // As the user types in the field they are in: a press first would
        // move its caret, collapsing a selection the typing replaces.
        let (id, _) = self.find(selector, "input", PickTarget::Input)?;
        if self.native.focused() != Some(id) {
            self.focus(selector)?;
        }
        // A line break is the return key, as the headless driver types it.
        for (i, line) in text.split('\n').enumerate() {
            if i > 0 {
                self.native.try_key(Key::Return)?;
            }
            if !line.is_empty() {
                self.native.try_type_text(line)?;
            }
        }
        self.settled()
    }

    fn submit(&self, selector: &str) -> Result<(), String> {
        self.focus(selector)?;
        self.native.try_key(Key::Return)?;
        self.settled()
    }

    fn clear(&self, selector: &str) -> Result<(), String> {
        self.focus(selector)?;
        self.native.try_key(Key::SelectAll)?;
        self.native.try_key(Key::Backspace)?;
        self.settled()
    }

    fn scroll(&self, selector: &str, distance: f32) -> Result<(), String> {
        let (id, at) = self.find(selector, "scroll view", PickTarget::ScrollView)?;
        let horizontal = self.scene.horizontal(id)?;
        let delta = if horizontal {
            Point::new(Points(distance), Points(0.0))
        } else {
            Point::new(Points(0.0), Points(distance))
        };
        self.native.scroll(at, delta);
        self.settled()
    }

    fn paste(&self, selector: &str, content: &nsh_core::PasteEvent) -> Result<(), String> {
        // As the user pastes into the field they are in: a press first
        // would move its caret, collapsing a selection the paste replaces.
        let (id, _) = self.find(selector, "input", PickTarget::Input)?;
        if self.native.focused() != Some(id) {
            self.focus(selector)?;
        }
        self.native.paste(content)?;
        self.settled()
    }

    fn compose(&self, selector: &str, text: &str) -> Result<(), String> {
        // In the field the user is in: a press would commit what it composes.
        let (id, _) = self.find(selector, "input", PickTarget::Input)?;
        if self.native.focused() != Some(id) {
            self.focus(selector)?;
        }
        self.native.compose(text)?;
        self.settled()
    }

    fn right_click(&self, selector: &str) -> Result<(), String> {
        if !self.native.mouse() {
            return Err(
                "this platform has no mouse to right-click with: run the test headless \
                        as a desktop (`platform`), or on a desktop or the web"
                    .into(),
            );
        }
        let (_, at) = self.find(selector, "view", PickTarget::View)?;
        self.native.right_click(at)?;
        self.settled()
    }

    fn choose_menu_item(&self, label: &str) -> Result<(), String> {
        let Some(items) = self.scene.menu()? else {
            // A menu the system draws for one of the app's views: the
            // platform finds the action by its label.
            if self.native.system_menu_open() {
                self.native.choose_menu_item(&crate::menu::path(label))?;
                return self.settled();
            }
            return Err("no context menu is open".into());
        };
        crate::menu::find(&items, label)?;
        self.native.choose_menu_item(&crate::menu::path(label))?;
        self.scene.menu_closed()?;
        self.settled()
    }

    fn close_menu(&self) -> Result<(), String> {
        if self.scene.menu()?.is_none() {
            if self.native.system_menu_open() {
                self.native.close_menu()?;
                return self.settled();
            }
            return Err("no context menu is open".into());
        }
        self.native.close_menu()?;
        self.scene.menu_closed()?;
        self.settled()
    }

    fn hover(&self, selector: &str) -> Result<(), String> {
        if !self.native.mouse() {
            return Err(
                "this platform has no mouse to hover with: run the test headless as a \
                        desktop (`platform`), or on a desktop or the web"
                    .into(),
            );
        }
        let (_, at) = self.find(selector, "view", PickTarget::View)?;
        self.native.hover(at)?;
        self.settled()
    }

    fn drag_and_hold(
        &self,
        selector: &str,
        x: f32,
        y: f32,
        options: DragOptions,
    ) -> Result<(), String> {
        self.release_held()?;
        let (_, at) = self.find(selector, "view", PickTarget::View)?;
        let to = Point::new(at.x + Points(x), at.y + Points(y));
        self.native.drag_and_hold(at, to, options)?;
        *self.held.lock().unwrap() = Some(to);
        self.settled()
    }

    /// Clearing the owner follows a successful Up; a failed release can be retried.
    fn release_held(&self) -> Result<bool, String> {
        let mut held = self.held.lock().unwrap();
        let Some(at) = *held else { return Ok(false) };
        self.native.drop_at(at)?;
        *held = None;
        Ok(true)
    }

    fn drop_held(&self) -> Result<(), String> {
        if !self.release_held()? {
            return Err("`drop()` comes after `dragAndHold`: no pointer is down".into());
        }
        self.settled()
    }

    fn drag(&self, selector: &str, x: f32, y: f32, options: DragOptions) -> Result<(), String> {
        self.release_held()?;
        let (_, at) = self.find(selector, "view", PickTarget::View)?;
        let to = Point::new(at.x + Points(x), at.y + Points(y));
        self.native.drag(at, to, options)?;
        self.settled()
    }

    fn answer_dialog(&self, button: Option<&str>) -> Result<(), String> {
        if self.scene.pending_dialog()?.is_none() {
            return Err("no dialog to answer".into());
        }
        self.native.answer_dialog(button)?;
        self.scene.answered()?;
        self.settled()
    }

    /// Waits until a view matches `selector` (none, when `gone`),
    /// `timeout` at most. On a manual clock the wait moves it, a display
    /// frame at a time, looking after each frame, by `timeout` at most, as
    /// headless; it fails once that much real time passed too.
    fn wait_for(&self, selector: &str, timeout: Duration, gone: bool) -> Result<(), String> {
        Selector::parse(selector)?;
        let deadline = Instant::now() + timeout;
        // On a manual clock: how far the wait moved it.
        let mut moved = self.scene.manual_clock().then_some(Duration::ZERO);
        loop {
            let seen = self.scene.activity()?.batches;
            let holds = self.scene.matches(selector)? != gone;
            self.check()?;
            if holds {
                return Ok(());
            }
            self.clear_quiet();
            // The clock moves by the timeout at most; then the wait goes on
            // for what comes from outside the app, until as much real time
            // passed.
            let clock_left = moved.map(|moved| timeout.saturating_sub(moved));
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() && clock_left.is_none_or(|l| l.is_zero()) {
                let what = if gone { "gone" } else { "showing" };
                return Err(format!(
                    "{}; {}",
                    crate::failure::never_happened(&format!("`{selector}` {what}"), timeout),
                    self.on_screen()
                ));
            }
            if let (Some(moved), Some(clock_left)) = (&mut moved, clock_left)
                && !clock_left.is_zero()
            {
                *moved += self.next_frame(seen, clock_left)?;
                continue;
            }
            self.scene.wait_for_batch(seen, left.min(POLL * 5));
        }
    }

    /// On a manual clock: moves it by a display frame (`left` at most) and
    /// looks for what came, as headless waits do between two looks; how
    /// far it moved. `seen` is the batches applied before.
    fn next_frame(&self, seen: u64, left: Duration) -> Result<Duration, String> {
        // Whole milliseconds, one at least: the wait's time runs out.
        let ms = left.min(FRAME).as_millis().max(1) as u64;
        self.scene
            .move_clock(nsh_dev::protocol::ClockChange::RunFor { ms })?;
        self.scene.wait_for_batch(seen, FRAME_LOOK);
        Ok(Duration::from_millis(ms))
    }

    fn clear_quiet(&self) {
        *self.quiet.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Whether the platform still changes what shows by itself: a native
    /// animation that ends by itself runs ([`Native::animating`]), or a
    /// window of the app's own waits to show ([`Native::opening`]).
    fn changing(&self) -> bool {
        self.native.animating() || self.native.opening()
    }

    /// [`Agent::settled`], but not again for an app that has not changed
    /// since the last step left it quiet: no batch came, nothing animates or
    /// opens, and the last one is older than [`QUIET`] (on a manual clock,
    /// `WaitFor` and `NextFrame` advance the clock with 2 ms waits without
    /// calling `settled()`, so the wait is never skipped).
    fn settled_unless_still(&self) -> Result<(), String> {
        let settled = *self.quiet.lock().unwrap_or_else(|e| e.into_inner());
        if settled.is_some() && !self.scene.manual_clock() {
            let activity = self.scene.activity()?;
            if is_still(settled, activity, self.changing()) {
                return self.check();
            }
        }
        self.settled()
    }

    /// Waits until the app is quiet ([`QUIET`], nothing the platform
    /// changes by itself: [`Agent::changing`]), [`SETTLE`] at most, then
    /// fails if it threw meanwhile.
    fn settled(&self) -> Result<(), String> {
        self.clear_quiet();
        let start = Instant::now();
        // When an animation last ran or a window last waited to show: what
        // it ends with (a screen popped once it slid out, what a window
        // tells the app once it shows) comes after it.
        let mut moved = start;
        let mut first = None;
        let quiet_batches;
        loop {
            let activity = self.scene.activity()?;
            let first = *first.get_or_insert(activity.batches);
            if self.changing() {
                moved = Instant::now();
            }
            // Quiet since the step began, the last batch and the last
            // animation or opening window.
            let since = activity
                .since_last
                .map_or(start.elapsed(), |d| d.min(start.elapsed()))
                .min(moved.elapsed());
            if since >= QUIET {
                quiet_batches = Some(activity.batches);
                break;
            }
            if start.elapsed() >= SETTLE {
                quiet_batches = None;
                // The step goes on all the same; why it waited this long
                // tells why a run is slow.
                log::info!(
                    "test agent: the app did not settle in {} s: {} batches came, an animation ran or a window waited to show {} ms ago",
                    SETTLE.as_secs(),
                    activity.batches - first,
                    moved.elapsed().as_millis()
                );
                break;
            }
            self.scene.wait_for_batch(activity.batches, POLL);
        }
        self.check()?;
        *self.quiet.lock().unwrap_or_else(|e| e.into_inner()) = quiet_batches;
        Ok(())
    }

    /// Waits until view `id` stops moving after a gesture scrolled it: its
    /// bounds the same over a few polls ([`SETTLE`] at most). What else the
    /// app does meanwhile (a ticking timer, an animation of its own) does
    /// not hold the next gesture back, as it holds a step's end
    /// ([`Agent::settled`]).
    fn stopped(&self, id: NodeId) -> Result<(), String> {
        const STILL: usize = 3;
        let start = Instant::now();
        let mut last = self.native.bounds(id);
        let mut still = 0;
        while still < STILL && start.elapsed() < SETTLE {
            std::thread::sleep(POLL);
            let now = self.native.bounds(id);
            if now == last {
                still += 1;
            } else {
                still = 0;
                last = now;
            }
        }
        self.check()
    }

    /// Fails with the app's first error since the last look.
    fn check(&self) -> Result<(), String> {
        match self.scene.take_errors()?.into_iter().next() {
            Some(error) => Err(format!("the app threw: {error}")),
            None => Ok(()),
        }
    }

    fn on_screen(&self) -> String {
        let texts = self.scene.texts().unwrap_or_default();
        format!(
            "on screen: [{}]",
            crate::failure::screen_texts(&texts, Some(crate::failure::SCREEN_TEXT_LIMIT))
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use nsh_core::{
        EventKind, EventPayload,
        geometry::{Size, point},
        prelude::*,
    };
    use nsh_engine::{EngineConfig, EngineControl};

    use super::{Key, *};

    /// A count and a button that adds one.
    #[component]
    fn Tally() -> impl IntoElement {
        let count = signal(0_u32);
        view()
            .child(text(move || format!("Count: {}", count.get())))
            .child(
                view()
                    .on_press(move || count.update(|c| *c += 1))
                    .child(text("Add")),
            )
    }

    /// A platform whose views are where their ids say (`x` is the id), and
    /// whose presses go to the view they are at, or, with the model, to the
    /// nearest view around it that takes presses, as a platform's hit test
    /// gives them, as the engine's events.
    struct Fake(EngineControl, Arc<Mutex<Vec<String>>>, Option<Arc<Model>>);

    impl Native for Fake {
        fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
            Some(Bounds::new(
                point(Points(id as f32 - 0.5), Points(0.0)),
                Size::new(Points(1.0), Points(1.0)),
            ))
        }
        fn viewport(&self) -> Size<Points> {
            Size::new(Points(10_000.0), Points(10_000.0))
        }
        fn press(&self, at: Point<Points>) {
            let hit = at.x.0.round() as NodeId;
            let id = self.2.as_ref().map_or(hit, |model| {
                let state = model.lock();
                state
                    .screen
                    .chain(hit)
                    .into_iter()
                    .find(|id| state.screen.hears(*id, EventKind::Press))
                    .unwrap_or(hit)
            });
            for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
                self.0.dispatch_event(id, kind, EventPayload::None);
            }
        }
        fn long_press(&self, _: Point<Points>, _: Duration) {}
        fn scroll(&self, _: Point<Points>, _: Point<Points>) {}
        fn drag(&self, _: Point<Points>, _: Point<Points>, _: DragOptions) -> Result<(), String> {
            Ok(())
        }
        fn type_text(&self, text: &str) {
            self.1.lock().unwrap().push(format!("type {text}"));
        }
        fn key(&self, key: Key) {
            self.1.lock().unwrap().push(format!("{key:?}"));
        }
        fn input_text(&self, _: NodeId) -> Option<String> {
            None
        }
        fn back(&self) -> Result<(), String> {
            Err("no back here".into())
        }
        fn answer_dialog(&self, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn animating(&self) -> bool {
            false
        }
        fn screenshot(&self) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn resize(&self, _: Points, _: Points) -> Result<(), String> {
            Ok(())
        }
        fn set_dark(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn quit(&self) {}
    }

    #[test]
    fn a_scrolling_finger_lands_clear_of_the_views_that_take_drags() {
        // A scroll view from 100 to 700: nothing covers its middle.
        assert_eq!(clear_spot(100.0, 600.0, 0.5, &[]), Some(0.5));
        assert_eq!(clear_spot(100.0, 600.0, 0.5, &[(500.0, 650.0)]), Some(0.5));
        // A drawing area over the middle: just past its nearer end.
        assert_eq!(
            clear_spot(100.0, 600.0, 0.5, &[(380.0, 560.0)]),
            Some((372.0 - 100.0) / 600.0)
        );
        // Two of them a gap apart, too narrow for a finger's margins.
        assert_eq!(
            clear_spot(100.0, 600.0, 0.5, &[(300.0, 395.0), (405.0, 600.0)]),
            Some((292.0 - 100.0) / 600.0)
        );
        // Covered from end to end.
        assert_eq!(clear_spot(100.0, 600.0, 0.5, &[(0.0, 800.0)]), None);
        assert_eq!(clear_spot(0.0, 0.0, 0.5, &[]), None);
    }

    /// A page a finger scrolls: scroll view 2, 560 points tall at the
    /// window's top, over 3000 points of content holding view 4 (40 points
    /// tall) at `target`; each gesture moves it as far as the finger moves,
    /// but the ones `undone` names (counted from 1), which a fling undoes.
    #[derive(Default)]
    struct Page {
        offset: Mutex<f32>,
        target: f32,
        undone: Vec<usize>,
        /// Where each gesture's finger landed, along the scroll view.
        landed: Arc<Mutex<Vec<f32>>>,
        /// What the scroll view's insets keep clear at its top and its
        /// bottom (a header it scrolls under, the keyboard): as on iOS, the
        /// content rests below the top one at the start and above the
        /// bottom one at the end.
        insets: (f32, f32),
        /// The scroll view is half a point tall.
        collapsed: bool,
        /// How far down a bar the platform draws covers the window, which
        /// a press above that reaches ([`Native::covered`]).
        bar: f32,
        /// Where each press landed, down the window.
        pressed: Arc<Mutex<Vec<f32>>>,
    }

    impl Page {
        const LENGTH: f32 = 560.0;
        const CONTENT: f32 = 3000.0;

        fn length(&self) -> f32 {
            if self.collapsed { 0.5 } else { Page::LENGTH }
        }

        /// How far it scrolls at most.
        fn end(&self) -> f32 {
            (Page::CONTENT + self.insets.0 + self.insets.1 - self.length()).max(0.0)
        }
    }

    impl Native for Page {
        fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
            let y = match id {
                2 => 0.0,
                4 => self.insets.0 + self.target - *self.offset.lock().unwrap(),
                _ => return None,
            };
            let height = if id == 2 { self.length() } else { 40.0 };
            Some(Bounds::new(
                point(px(0.0), px(y)),
                size(px(320.0), px(height)),
            ))
        }
        fn scroll_room(&self, _: NodeId, _: bool) -> Option<(Points, Points)> {
            let offset = *self.offset.lock().unwrap();
            Some((px(offset), px(self.end() - offset)))
        }
        fn scroll_insets(&self, _: NodeId, _: bool) -> (Points, Points) {
            (px(self.insets.0), px(self.insets.1))
        }
        fn covered(&self, _: NodeId, at: Point<Points>) -> Option<String> {
            (at.y.0 < self.bar).then(|| "a navigation bar".to_owned())
        }
        fn viewport(&self) -> Size<Points> {
            size(px(320.0), px(640.0))
        }
        fn press(&self, at: Point<Points>) {
            self.pressed.lock().unwrap().push(at.y.0);
        }
        fn long_press(&self, _: Point<Points>, _: Duration) {}
        fn scroll(&self, at: Point<Points>, delta: Point<Points>) {
            let mut landed = self.landed.lock().unwrap();
            landed.push(at.y.0);
            if !self.undone.contains(&landed.len()) {
                let mut offset = self.offset.lock().unwrap();
                *offset = (*offset + delta.y.0).clamp(0.0, self.end());
            }
        }
        fn drag(&self, _: Point<Points>, _: Point<Points>, _: DragOptions) -> Result<(), String> {
            Ok(())
        }
        fn type_text(&self, _: &str) {}
        fn key(&self, _: Key) {}
        fn input_text(&self, _: NodeId) -> Option<String> {
            None
        }
        fn back(&self) -> Result<(), String> {
            Ok(())
        }
        fn answer_dialog(&self, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn animating(&self) -> bool {
            false
        }
        fn screenshot(&self) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn resize(&self, _: Points, _: Points) -> Result<(), String> {
            Ok(())
        }
        fn set_dark(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn quit(&self) {}
    }

    #[test]
    fn a_gesture_that_moves_nothing_costs_the_next_ones_no_reach() {
        use nsh_core::{MountItem, ViewKind};
        // Where the finger lands to bring view 4 at `target` into view
        // from `offset`, the gestures `undone` undone.
        let landings = |target: f32, offset: f32, undone: Vec<usize>| {
            let model = Arc::new(Model::default());
            model.apply(&MountBatch {
                items: vec![
                    MountItem::Create {
                        id: 2,
                        kind: ViewKind::Scroll,
                    },
                    MountItem::Create {
                        id: 4,
                        kind: ViewKind::View,
                    },
                    MountItem::Insert {
                        parent: 1,
                        child: 2,
                        before: None,
                    },
                    MountItem::Insert {
                        parent: 2,
                        child: 4,
                        before: None,
                    },
                ],
            });
            let landed = Arc::new(Mutex::new(Vec::new()));
            let page = Page {
                offset: Mutex::new(offset),
                target,
                undone,
                landed: landed.clone(),
                ..Page::default()
            };
            let agent = Agent::new(model, Box::new(page));
            let (at, scrolled) = agent.bring_into_view(4, "id:far", None).unwrap();
            assert!(scrolled);
            assert!((48.0..=512.0).contains(&at.y.0), "{at:?}");
            landed.lock().unwrap().clone()
        };
        // Where the finger lands: the middle, a quarter of the way from the
        // top, a quarter of the way from the bottom.
        let (middle, top, bottom) = (Page::LENGTH / 2.0, Page::LENGTH / 4.0, Page::LENGTH * 0.75);
        // Far down the page, the second gesture undone (a fling back): the
        // finger moves up from the bottom quarter, where it has the most
        // room, and the view comes into view in time (from the top quarter
        // each gesture reached 84 points, and the view needed 23).
        let down = landings(2400.0, 0.0, vec![2]);
        assert_eq!(down[..2], [middle, middle]);
        assert!(down[2..].iter().all(|&y| y == bottom), "{down:?}");
        // Far up: it moves down from the top quarter.
        let up = landings(100.0, Page::CONTENT - Page::LENGTH, vec![2]);
        assert_eq!(up[..2], [middle, middle]);
        assert!(up[2..].iter().all(|&y| y == top), "{up:?}");
        // Where nothing moves either (what is there scrolls by itself), the
        // finger moves to the other quarter.
        let near = landings(900.0, 0.0, vec![2, 3]);
        assert_eq!(near[..2], [middle, middle]);
        assert!(
            near[2] == bottom && near[3..].iter().all(|&y| y == top),
            "{near:?}"
        );
    }

    #[test]
    fn a_view_no_gesture_brings_nearer_is_pressed_where_it_is() {
        use nsh_core::{MountItem, ViewKind};
        // The gestures that bring view 4 at `target` into view from
        // `offset`, in a modal (6) shown from inside scroll view 2 or in the
        // scroll view itself.
        let landings = |target: f32, offset: f32, modal: bool| {
            let model = Arc::new(Model::default());
            let create = |id, kind| MountItem::Create { id, kind };
            let insert = |parent, child| MountItem::Insert {
                parent,
                child,
                before: None,
            };
            let mut items = vec![
                create(2, ViewKind::Scroll),
                create(4, ViewKind::View),
                insert(1, 2),
            ];
            if modal {
                items.extend([create(6, ViewKind::Modal), insert(2, 6), insert(6, 4)]);
            } else {
                items.push(insert(2, 4));
            }
            model.apply(&MountBatch { items });
            let landed = Arc::new(Mutex::new(Vec::new()));
            let page = Page {
                offset: Mutex::new(offset),
                target,
                undone: Vec::new(),
                landed: landed.clone(),
                ..Page::default()
            };
            let agent = Agent::new(model, Box::new(page));
            let (at, _) = agent.bring_into_view(4, "id:row", None).unwrap();
            (at.y.0, landed.lock().unwrap().len())
        };
        // At the top edge of a scroll view at its top: a finger dragging it
        // down would pull it past its top (a pull to refresh, a page sheet
        // closing), so it is pressed where it is.
        assert_eq!(landings(10.0, 0.0, false), (30.0, 0));
        // Scrolled down, the scroll view brings it nearer.
        assert!(landings(300.0, 280.0, false).1 > 0);
        // A modal shows over the window: the scroll view around it in the
        // tree does not move it.
        assert_eq!(landings(300.0, 280.0, true), (40.0, 0));
    }

    /// Scroll view 2 holding view 4, which takes presses.
    fn page_model() -> Arc<Model> {
        use nsh_core::{EventMask, MountItem, ViewKind};
        let model = Arc::new(Model::default());
        let mut events = EventMask::default();
        events.set(EventKind::Press, true);
        model.apply(&MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Scroll,
                },
                MountItem::Create {
                    id: 4,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: 1,
                    child: 2,
                    before: None,
                },
                MountItem::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(point(px(0.0), px(0.0)), size(px(320.0), px(Page::LENGTH))),
                },
                MountItem::Frame {
                    id: 4,
                    frame: Bounds::new(point(px(0.0), px(0.0)), size(px(320.0), px(40.0))),
                },
                MountItem::Events { id: 4, events },
            ],
        });
        model
    }

    #[test]
    fn a_view_under_the_insets_of_its_scroll_view_comes_out_from_under_them() {
        // The scroll view runs under a header 103 points tall and keeps 34
        // clear at its bottom, scrolled down 200 points: view 4's middle is
        // 80 points down, under the header, though well inside the scroll
        // view's bounds.
        let gestures = |insets: (f32, f32)| {
            let landed = Arc::new(Mutex::new(Vec::new()));
            let page = Page {
                offset: Mutex::new(200.0),
                target: 80.0 - 20.0 - insets.0 + 200.0,
                landed: landed.clone(),
                insets,
                ..Page::default()
            };
            let agent = Agent::new(page_model(), Box::new(page));
            let (at, scrolled) = agent.bring_into_view(4, "id:row", None).unwrap();
            (at.y.0, scrolled, landed.lock().unwrap().clone())
        };
        // Where nothing draws over the scroll view (the desktops), it is
        // pressed where it is.
        assert_eq!(gestures((0.0, 0.0)), (80.0, false, Vec::new()));
        // Under the header, it is scrolled out to well inside the part the
        // header leaves showing (103 to 526), and the finger that scrolls
        // it lands there too, not on the header.
        let (at, scrolled, landed) = gestures((103.0, 34.0));
        assert!(scrolled);
        assert!((103.0 + 42.0..=526.0 - 42.0).contains(&at), "{at}");
        assert!(
            !landed.is_empty() && landed.iter().all(|y| (103.0..=526.0).contains(y)),
            "{landed:?}"
        );
    }

    #[test]
    fn a_view_left_under_a_header_fails_the_step_instead_of_pressing_the_header() {
        let ok = StepOutcome::Done {
            value: serde_json::Value::Null,
        };
        let press = |page: Page| {
            let pressed = page.pressed.clone();
            let agent = Agent::new(page_model(), Box::new(page));
            let outcome = agent.take(TestStep::Press {
                selector: "view:4".into(),
            });
            (outcome, pressed.lock().unwrap().clone())
        };
        let under = |outcome: &StepOutcome| matches!(outcome, StepOutcome::Failed { message } if message.starts_with("`view:4` is covered: a press there reaches what draws over the edge of its scroll view"));
        // Under the header, in a scroll view the gestures do not move (what
        // is there scrolls by itself, or flings undo them): it stays under.
        let (outcome, pressed) = press(Page {
            offset: Mutex::new(200.0),
            target: 80.0 - 20.0 - 103.0 + 200.0,
            insets: (103.0, 34.0),
            undone: (1..=SCROLLS_INTO_VIEW).collect(),
            ..Page::default()
        });
        assert!(under(&outcome), "{outcome:?}");
        assert!(pressed.is_empty());
        // Insets that cover the scroll view from end to end (a keyboard over
        // a short one).
        let (outcome, pressed) = press(Page {
            target: 40.0,
            insets: (300.0, 300.0),
            ..Page::default()
        });
        assert!(under(&outcome), "{outcome:?}");
        assert!(pressed.is_empty());
        // A scroll view half a point tall with nothing over it is no
        // covered one: its gestures go on as before (each moves it a
        // fraction of a point) until none brings it nearer, and the view is
        // pressed where it is then.
        let (outcome, pressed) = press(Page {
            target: 40.0,
            collapsed: true,
            ..Page::default()
        });
        assert_eq!(outcome, ok);
        assert_eq!(pressed.len(), 1, "{pressed:?}");
        // A platform that does not say what the insets keep clear, but
        // finds the header under the finger: the step fails, naming it.
        let (outcome, pressed) = press(Page {
            target: 40.0,
            bar: 103.0,
            ..Page::default()
        });
        assert!(
            matches!(&outcome, StepOutcome::Failed { message } if message.starts_with("`view:4` is covered: a press there reaches a navigation bar")),
            "{outcome:?}"
        );
        assert!(pressed.is_empty());
        // Clear of the header, it is pressed.
        let (outcome, pressed) = press(Page {
            target: 200.0,
            bar: 103.0,
            insets: (103.0, 34.0),
            ..Page::default()
        });
        assert_eq!(outcome, ok);
        assert_eq!(pressed, [323.0]);
    }

    #[test]
    fn canvas_nodes_keep_their_centers_in_local_and_remote_scenes() {
        use nsh_core::{
            EventMask, MountItem, ViewKind,
            canvas::{CanvasNode, Drawing},
        };
        let model = Arc::new(Model::default());
        let bounds = Bounds::new(point(px(0.0), px(0.0)), size(px(200.0), px(40.0)));
        let mut events = EventMask::default();
        events.set(EventKind::Press, true);
        let mut drawing = Drawing::default();
        drawing.nodes.push(
            CanvasNode::new(
                Bounds::new(point(px(100.0), px(0.0)), size(px(100.0), px(40.0))),
                nsh_core::AccessibilityRole::Text,
                "cell",
            )
            .test_id("cell"),
        );
        model.apply(&MountBatch {
            items: vec![
                MountItem::Create {
                    id: 4,
                    kind: ViewKind::View,
                },
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Canvas,
                },
                MountItem::Frame {
                    id: 4,
                    frame: bounds,
                },
                MountItem::Frame {
                    id: 2,
                    frame: bounds,
                },
                MountItem::Insert {
                    parent: 1,
                    child: 4,
                    before: None,
                },
                MountItem::Insert {
                    parent: 4,
                    child: 2,
                    before: None,
                },
                MountItem::Events { id: 4, events },
                MountItem::Canvas {
                    id: 2,
                    drawing: Arc::new(drawing),
                },
            ],
        });
        let remote_model = model.clone();
        let remote = Arc::new(RemoteScene::new(move |step| {
            answer(&remote_model, &step).unwrap()
        }));
        let (engine, _batches) =
            crate::start(EngineConfig::new(crate::windowed_root::<Tally>())).unwrap();
        for scene in [model as Arc<dyn Scene>, remote as Arc<dyn Scene>] {
            let agent = Agent::new(
                scene,
                Box::new(Fake(
                    engine.control(),
                    Arc::new(Mutex::new(Vec::new())),
                    None,
                )),
            );
            // Fake's canvas starts at x=1.5; its pad's center is x=4.
            assert_eq!(
                agent.find("id:cell", "pressable view", PickTarget::Pressable),
                Ok((4, point(px(151.5), px(20.0))))
            );
        }
    }

    /// A platform that draws a control of its own for the app (a header
    /// button named `more`, labelled "More", at x 500) and shows its menus
    /// itself: what reaches it is logged.
    struct SystemDrawn(Arc<Mutex<Vec<String>>>);

    impl Native for SystemDrawn {
        fn bounds(&self, _: NodeId) -> Option<Bounds<Points>> {
            None
        }
        fn viewport(&self) -> Size<Points> {
            Size::new(Points(1000.0), Points(1000.0))
        }
        fn press(&self, at: Point<Points>) {
            self.0.lock().unwrap().push(format!("press {}", at.x.0));
        }
        fn long_press(&self, _: Point<Points>, _: Duration) {}
        fn scroll(&self, _: Point<Points>, _: Point<Points>) {}
        fn drag(&self, _: Point<Points>, _: Point<Points>, _: DragOptions) -> Result<(), String> {
            Ok(())
        }
        fn type_text(&self, _: &str) {}
        fn key(&self, _: Key) {}
        fn input_text(&self, _: NodeId) -> Option<String> {
            None
        }
        fn back(&self) -> Result<(), String> {
            Ok(())
        }
        fn answer_dialog(&self, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn animating(&self) -> bool {
            false
        }
        fn screenshot(&self) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn resize(&self, _: Points, _: Points) -> Result<(), String> {
            Ok(())
        }
        fn set_dark(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn quit(&self) {}
        fn choose_menu_item(&self, path: &[String]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .push(format!("choose {}", path.join("/")));
            Ok(())
        }
        fn close_menu(&self) -> Result<(), String> {
            self.0.lock().unwrap().push("close".into());
            Ok(())
        }
        fn system_menu_open(&self) -> bool {
            true
        }
        fn system_control(&self, name: SystemName<'_>) -> Option<Bounds<Points>> {
            matches!(name, SystemName::TestId("more") | SystemName::Label("More")).then(|| {
                Bounds::new(
                    point(Points(490.0), Points(0.0)),
                    Size::new(Points(20.0), Points(20.0)),
                )
            })
        }
    }

    #[test]
    fn the_agent_presses_and_chooses_from_what_the_platform_draws() {
        let (engine, batches) =
            crate::start(EngineConfig::new(crate::windowed_root::<Tally>())).unwrap();
        let model = Arc::new(Model::default());
        let feeding = model.clone();
        std::thread::spawn(move || {
            while let Ok(batch) = batches.recv() {
                feeding.apply(&batch);
            }
        });
        let log = Arc::new(Mutex::new(Vec::new()));
        let agent = Agent::new(model.clone(), Box::new(SystemDrawn(log.clone())));
        let ok = StepOutcome::Done {
            value: serde_json::Value::Null,
        };
        assert_eq!(agent.take(TestStep::Ready { timeout_ms: 5000 }), ok);
        // Not one of the app's views: the platform's control of that name,
        // by its id, its label, or either for a bare name.
        for selector in ["id:more", "label:More", "more", "More"] {
            assert_eq!(
                agent.take(TestStep::Press {
                    selector: selector.into()
                }),
                ok,
                "{selector}"
            );
        }
        // Named by nothing the platform draws (or by more than a name): the
        // app's views' failure.
        for selector in ["id:less", "text:More", "id:more >> nth=0"] {
            assert!(
                matches!(
                    agent.take(TestStep::Press { selector: selector.into() }),
                    StepOutcome::Failed { message } if message.starts_with("no pressable view matches")
                ),
                "{selector}"
            );
        }
        // No menu of the app's is open: the platform's own is chosen from.
        assert_eq!(
            agent.take(TestStep::ChooseMenuItem {
                label: "Sort > By name".into()
            }),
            ok
        );
        assert_eq!(agent.take(TestStep::CloseMenu), ok);
        assert_eq!(
            *log.lock().unwrap(),
            [
                "press 500",
                "press 500",
                "press 500",
                "press 500",
                "choose Sort/By name",
                "close"
            ]
        );
        drop(engine);
    }

    #[test]
    fn the_agent_finds_views_in_the_model_and_acts_where_they_are() {
        let (engine, batches) =
            crate::start(EngineConfig::new(crate::windowed_root::<Tally>())).unwrap();
        let model = Arc::new(Model::default());
        let feeding = model.clone();
        std::thread::spawn(move || {
            while let Ok(batch) = batches.recv() {
                feeding.apply(&batch);
            }
        });
        let typed = Arc::new(Mutex::new(Vec::new()));
        let agent = Agent::new(
            model.clone(),
            Box::new(Fake(engine.control(), typed.clone(), Some(model.clone()))),
        );
        let ok = StepOutcome::Done {
            value: serde_json::Value::Null,
        };
        assert_eq!(agent.take(TestStep::Ready { timeout_ms: 5000 }), ok);
        assert_eq!(
            agent.take(TestStep::Texts),
            StepOutcome::Done {
                value: serde_json::json!(["Count: 0", "Add"])
            }
        );
        // The press goes to the button, at its text, as a finger taps what
        // it reads.
        let (button, at) = agent
            .find("Add", "pressable view", PickTarget::Pressable)
            .unwrap();
        let label = model
            .lock()
            .screen
            .resolve(&Selector::parse("Add").unwrap());
        assert_eq!(label.len(), 1);
        assert_ne!(label[0], button);
        assert_eq!(at.x.0.round() as NodeId, label[0]);
        assert_eq!(
            agent.take(TestStep::Press {
                selector: "Add".into()
            }),
            ok
        );
        assert_eq!(
            agent.take(TestStep::WaitFor {
                selector: "Count: 1".into(),
                timeout_ms: 2000,
                gone: false
            }),
            ok
        );
        assert_eq!(
            agent.take(TestStep::Press {
                selector: "Nothing".into()
            }),
            StepOutcome::Failed {
                message: "no pressable view matches `Nothing`; on screen: [\"Count: 1\", \"Add\"]"
                    .into()
            }
        );
        assert_eq!(
            agent.take(TestStep::Back),
            StepOutcome::Failed {
                message: "no back here".into()
            }
        );
        // Only the web's native goes forward.
        assert_eq!(
            agent.take(TestStep::Forward),
            StepOutcome::Failed {
                message: crate::failure::web_only("forward")
            }
        );
        // No input to type into.
        assert!(matches!(
            agent.take(TestStep::Type { selector: "Add".into(), text: "x".into() }),
            StepOutcome::Failed { message } if message.starts_with("no input matches `Add`")
        ));
        assert!(typed.lock().unwrap().is_empty());
        drop(engine);
    }

    #[test]
    fn covered_inputs_fail_before_native_input_even_when_focused() {
        use nsh_core::{MountItem, ViewKind};
        let model = Arc::new(Model::default());
        let mut items = Vec::new();
        for id in [2, 3] {
            items.extend([
                MountItem::Create {
                    id,
                    kind: ViewKind::Input,
                },
                MountItem::Insert {
                    parent: 1,
                    child: id,
                    before: None,
                },
                MountItem::Frame {
                    id,
                    frame: Bounds::new(point(px(0.0), px(0.0)), size(px(200.0), px(40.0))),
                },
            ]);
        }
        model.apply(&MountBatch { items });
        let did = Arc::new(Mutex::new(Vec::new()));
        let agent = Agent::new(
            model,
            Box::new(Field {
                did: did.clone(),
                focused: Mutex::new(true),
            }),
        );
        for step in [
            TestStep::Clear {
                selector: "view:2".into(),
            },
            TestStep::Type {
                selector: "view:2".into(),
                text: "X".into(),
            },
        ] {
            assert!(
                matches!(agent.take(step), StepOutcome::Failed { message } if message.contains("is covered") && message.contains("view:3"))
            );
        }
        assert!(did.lock().unwrap().is_empty());
    }

    #[test]
    fn local_and_remote_values_read_composite_input_text() {
        use nsh_core::{AccessibilityValue, MountItem, ViewKind, ViewProps};
        let model = Arc::new(Model::default());
        model.apply(&MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Input,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(point(px(0.0), px(0.0)), size(px(200.0), px(40.0))),
                },
                MountItem::Insert {
                    parent: 1,
                    child: 2,
                    before: None,
                },
            ],
        });
        let remote_model = model.clone();
        let remote = Arc::new(RemoteScene::new(move |step| {
            answer(&remote_model, &step).unwrap()
        }));
        for text in ["Hallo\nworld", "AHallo\nworld", "external", ""] {
            let mut props = ViewProps::default();
            props.accessibility.value = Some(AccessibilityValue {
                text: Some(text.into()),
                ..Default::default()
            });
            model.apply(&MountBatch {
                items: vec![MountItem::ViewProps {
                    id: 2,
                    props: Box::new(props),
                }],
            });
            for scene in [model.clone() as Arc<dyn Scene>, remote.clone()] {
                let agent = Agent::new(
                    scene,
                    Box::new(Field {
                        did: Arc::default(),
                        focused: Mutex::new(false),
                    }),
                );
                assert_eq!(
                    agent.take(TestStep::Value {
                        selector: "view:2".into()
                    }),
                    StepOutcome::Done {
                        value: serde_json::json!(text)
                    }
                );
            }
        }
    }

    /// A field (view 2): what the agent does to it, and whether it has the
    /// keyboard focus.
    struct Field {
        did: Arc<Mutex<Vec<String>>>,
        focused: Mutex<bool>,
    }

    impl Native for Field {
        fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
            (id == 2).then(|| {
                Bounds::new(
                    point(Points(0.0), Points(0.0)),
                    Size::new(Points(200.0), Points(40.0)),
                )
            })
        }
        fn viewport(&self) -> Size<Points> {
            Size::new(Points(400.0), Points(400.0))
        }
        fn press(&self, _: Point<Points>) {
            *self.focused.lock().unwrap() = true;
            self.did.lock().unwrap().push("press".into());
        }
        fn long_press(&self, _: Point<Points>, _: Duration) {}
        fn scroll(&self, _: Point<Points>, _: Point<Points>) {}
        fn drag(&self, _: Point<Points>, _: Point<Points>, _: DragOptions) -> Result<(), String> {
            Ok(())
        }
        fn type_text(&self, text: &str) {
            self.did.lock().unwrap().push(format!("type {text}"));
        }
        fn key(&self, key: Key) {
            self.did.lock().unwrap().push(format!("{key:?}"));
        }
        fn focused(&self) -> Option<NodeId> {
            self.focused.lock().unwrap().then_some(2)
        }
        fn input_text(&self, _: NodeId) -> Option<String> {
            None
        }
        fn back(&self) -> Result<(), String> {
            Err("no back here".into())
        }
        fn answer_dialog(&self, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn animating(&self) -> bool {
            false
        }
        fn screenshot(&self) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn resize(&self, _: Points, _: Points) -> Result<(), String> {
            Ok(())
        }
        fn set_dark(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn quit(&self) {}
    }

    #[test]
    fn typing_into_the_focused_field_keeps_its_caret_and_selection() {
        use nsh_core::{MountItem, ViewKind};
        // #2180: a press before typing would collapse a selection (Cmd+A)
        // the typing replaces, as it does when the user types.
        let model = Arc::new(Model::default());
        model.apply(&MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Input,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(
                        point(Points(0.0), Points(0.0)),
                        Size::new(Points(200.0), Points(40.0)),
                    ),
                },
                MountItem::Insert {
                    parent: 1,
                    child: 2,
                    before: None,
                },
            ],
        });
        let did = Arc::new(Mutex::new(Vec::new()));
        let field = Field {
            did: did.clone(),
            focused: Mutex::new(false),
        };
        let agent = Agent::new(model, Box::new(field));
        let ok = StepOutcome::Done {
            value: serde_json::Value::Null,
        };
        let step = |text: &str| TestStep::Type {
            selector: "view:2".into(),
            text: text.into(),
        };
        // Not focused: pressed to take the focus.
        assert_eq!(agent.take(step("A")), ok);
        // Focused: typed where its caret is.
        assert_eq!(agent.take(step("Y")), ok);
        assert_eq!(*did.lock().unwrap(), ["press", "type A", "type Y"]);
    }

    struct CountingScene {
        inner: Arc<Model>,
        waits: std::sync::atomic::AtomicUsize,
        manual_clock: bool,
    }

    impl CountingScene {
        fn new(inner: Arc<Model>, manual_clock: bool) -> Self {
            Self {
                inner,
                waits: std::sync::atomic::AtomicUsize::new(0),
                manual_clock,
            }
        }

        fn take_waits(&self) -> usize {
            self.waits.swap(0, std::sync::atomic::Ordering::Relaxed)
        }
    }

    impl Scene for CountingScene {
        fn activity(&self) -> Result<Activity, String> {
            self.inner.activity()
        }
        fn wait_for_batch(&self, seen: u64, timeout: Duration) {
            self.waits
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            self.inner.wait_for_batch(seen, timeout);
        }
        fn take_errors(&self) -> Result<Vec<String>, String> {
            self.inner.take_errors()
        }
        fn input_value_text(&self, selector: &str) -> Result<Option<String>, String> {
            self.inner.input_value_text(selector)
        }
        fn pick(&self, selector: &str, target: PickTarget) -> Result<Pick, String> {
            self.inner.pick(selector, target)
        }
        fn scroll_ancestors(&self, id: NodeId) -> Result<Vec<(NodeId, bool)>, String> {
            self.inner.scroll_ancestors(id)
        }
        fn drag_takers(&self, id: NodeId) -> Result<Vec<NodeId>, String> {
            self.inner.drag_takers(id)
        }
        fn long_press_delay(&self, id: NodeId) -> Result<Option<f32>, String> {
            self.inner.long_press_delay(id)
        }
        fn horizontal(&self, id: NodeId) -> Result<bool, String> {
            self.inner.horizontal(id)
        }
        fn texts(&self) -> Result<Vec<String>, String> {
            self.inner.texts()
        }
        fn count(&self, selector: &str) -> Result<usize, String> {
            self.inner.count(selector)
        }
        fn matches(&self, selector: &str) -> Result<bool, String> {
            self.inner.matches(selector)
        }
        fn enabled(&self, selector: &str) -> Result<bool, String> {
            self.inner.enabled(selector)
        }
        fn span_style(&self, selector: &str) -> Result<SpanStyle, String> {
            self.inner.span_style(selector)
        }
        fn view_style(&self, selector: &str) -> Result<Option<ViewStyle>, String> {
            self.inner.view_style(selector)
        }
        fn layout(&self, selector: &str) -> Result<Option<ViewLayout>, String> {
            self.inner.layout(selector)
        }
        fn accessibility(
            &self,
            selector: Option<&str>,
        ) -> Result<Option<AccessibilityNode>, String> {
            self.inner.accessibility(selector)
        }
        fn input_id(&self, selector: &str) -> Result<Option<NodeId>, String> {
            self.inner.input_id(selector)
        }
        fn dialogs(&self) -> Result<Vec<nsh_core::Dialog>, String> {
            self.inner.dialogs()
        }
        fn pending_dialog(&self) -> Result<Option<nsh_core::Dialog>, String> {
            self.inner.pending_dialog()
        }
        fn answered(&self) -> Result<(), String> {
            self.inner.answered()
        }
        fn menu(&self) -> Result<Option<Vec<nsh_core::desktop::MenuItem>>, String> {
            self.inner.menu()
        }
        fn menu_closed(&self) -> Result<(), String> {
            self.inner.menu_closed()
        }
        fn clipboard(&self) -> Result<Option<String>, String> {
            self.inner.clipboard()
        }
        fn storage(&self) -> Result<std::collections::BTreeMap<String, String>, String> {
            self.inner.storage()
        }
        fn set_viewport(&self, size: Size<Points>) -> Result<(), String> {
            self.inner.set_viewport(size)
        }
        fn span(&self, id: NodeId) -> Result<Option<(NodeId, u32, u32)>, String> {
            self.inner.span(id)
        }
        fn canvas_node(&self, selector: &str) -> Result<Option<(NodeId, Point<Points>)>, String> {
            self.inner.canvas_node(selector)
        }
        fn match_inside(&self, selector: &str, id: NodeId) -> Result<Option<NodeId>, String> {
            self.inner.match_inside(selector, id)
        }
        fn move_clock(&self, change: nsh_dev::protocol::ClockChange) -> Result<(), String> {
            self.inner.move_clock(change)
        }
        fn manual_clock(&self) -> bool {
            self.manual_clock
        }
        fn send_host_event(&self, name: &str, data: serde_json::Value) -> Result<(), String> {
            self.inner.send_host_event(name, data)
        }
        fn opened_urls(&self) -> Result<Vec<String>, String> {
            Scene::opened_urls(&*self.inner)
        }
        fn window_root(&self, id: &str) -> Result<Option<NodeId>, String> {
            self.inner.window_root(id)
        }
        fn window_of(&self, id: NodeId) -> Result<NodeId, String> {
            self.inner.window_of(id)
        }
    }

    #[test]
    fn consecutive_steps_on_a_still_app_skip_redundant_settle() {
        let (engine, batches) =
            crate::start(EngineConfig::new(crate::windowed_root::<Tally>())).unwrap();
        let model = Arc::new(Model::default());
        let feeding = model.clone();
        std::thread::spawn(move || {
            while let Ok(batch) = batches.recv() {
                feeding.apply(&batch);
            }
        });
        let scene = Arc::new(CountingScene::new(model.clone(), false));
        let typed = Arc::new(Mutex::new(Vec::new()));
        let agent = Agent::new(
            scene.clone(),
            Box::new(Fake(engine.control(), typed, Some(model.clone()))),
        );
        let ok = StepOutcome::Done {
            value: serde_json::Value::Null,
        };
        assert_eq!(agent.take(TestStep::Ready { timeout_ms: 5000 }), ok);

        // Immediately after `Ready`, `find()` skips `settled()` with 0 waits.
        scene.take_waits();
        agent
            .find("Add", "pressable view", PickTarget::Pressable)
            .unwrap();
        assert_eq!(scene.take_waits(), 0);

        for _ in 0..10 {
            assert_eq!(
                agent.take(TestStep::Press {
                    selector: "Add".into(),
                }),
                ok
            );
            scene.take_waits();
            agent
                .find("Add", "pressable view", PickTarget::Pressable)
                .unwrap();
            assert_eq!(scene.take_waits(), 0);
        }
        assert_eq!(
            agent.take(TestStep::Texts),
            StepOutcome::Done {
                value: serde_json::json!(["Count: 10", "Add"])
            }
        );
        assert!(agent.quiet.lock().unwrap().is_some());

        // `WaitFor` that already matches on the first check keeps `quiet`.
        assert_eq!(
            agent.take(TestStep::WaitFor {
                selector: "Count: 10".into(),
                timeout_ms: 50,
                gone: false,
            }),
            ok
        );
        scene.take_waits();
        agent
            .find("Add", "pressable view", PickTarget::Pressable)
            .unwrap();
        assert_eq!(scene.take_waits(), 0);

        // `WaitFor` that waits past the first failed check clears `quiet`.
        assert!(matches!(
            agent.take(TestStep::WaitFor {
                selector: "No such view".into(),
                timeout_ms: 5,
                gone: false,
            }),
            StepOutcome::Failed { .. }
        ));
        assert_eq!(*agent.quiet.lock().unwrap(), None);
        scene.take_waits();
        agent
            .find("Add", "pressable view", PickTarget::Pressable)
            .unwrap();
        assert!(scene.take_waits() > 0);
        assert!(agent.quiet.lock().unwrap().is_some());

        // Time-advancing wait steps that do not settle at the end clear `quiet`
        // so the next action settles again.
        assert_eq!(agent.take(TestStep::Wait { ms: 1 }), ok);
        assert_eq!(*agent.quiet.lock().unwrap(), None);
        scene.take_waits();
        agent
            .find("Add", "pressable view", PickTarget::Pressable)
            .unwrap();
        assert!(scene.take_waits() > 0);
        assert!(agent.quiet.lock().unwrap().is_some());

        // An intervening batch between steps invalidates the still state, so
        // the next `find()` still waits for `QUIET`.
        model.apply(&MountBatch { items: Vec::new() });
        scene.take_waits();
        agent
            .find("Add", "pressable view", PickTarget::Pressable)
            .unwrap();
        assert!(scene.take_waits() > 0);

        // On a manual clock, `settled_unless_still` never skips `settled()`.
        let manual_scene = Arc::new(CountingScene::new(model.clone(), true));
        let manual_agent = Agent::new(
            manual_scene.clone(),
            Box::new(Fake(
                engine.control(),
                Arc::new(Mutex::new(Vec::new())),
                Some(model),
            )),
        );
        assert_eq!(manual_agent.take(TestStep::Ready { timeout_ms: 5000 }), ok);
        assert!(manual_agent.quiet.lock().unwrap().is_some());
        manual_scene.take_waits();
        manual_agent
            .find("Add", "pressable view", PickTarget::Pressable)
            .unwrap();
        assert!(manual_scene.take_waits() > 0);

        drop(engine);
    }

    #[test]
    fn still_skip_decision_checks_every_branch() {
        let quiet = Activity {
            batches: 5,
            since_last: Some(QUIET),
        };
        assert!(is_still(Some(5), quiet, false));

        // Previous settle timed out at `SETTLE` (or cleared by `Wait`).
        assert!(!is_still(None, quiet, false));

        // A new batch arrived since the previous settle finished.
        assert!(!is_still(
            Some(5),
            Activity {
                batches: 6,
                since_last: Some(QUIET),
            },
            false,
        ));

        // Not enough quiet time since the last batch, or no batch yet.
        assert!(!is_still(
            Some(5),
            Activity {
                batches: 5,
                since_last: Some(QUIET.saturating_sub(Duration::from_millis(1))),
            },
            false,
        ));
        assert!(!is_still(
            Some(5),
            Activity {
                batches: 5,
                since_last: None,
            },
            false,
        ));

        // A finite native animation is running, or a window waits to show.
        assert!(!is_still(Some(5), quiet, true));
    }

    /// [`Fake`] whose window opens hidden and shows by itself at
    /// `shows_at`, as a window of the app's own waits for its first frame:
    /// a press while it is hidden is lost, as AppKit gives a window that is
    /// not visible no mouse events.
    struct Opening {
        fake: Fake,
        shows_at: Arc<Mutex<Instant>>,
        /// The presses that came while it was hidden.
        lost: Arc<Mutex<usize>>,
    }

    impl Native for Opening {
        fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
            self.fake.bounds(id)
        }
        fn viewport(&self) -> Size<Points> {
            self.fake.viewport()
        }
        fn press(&self, at: Point<Points>) {
            if self.opening() {
                *self.lost.lock().unwrap() += 1;
            } else {
                self.fake.press(at);
            }
        }
        fn long_press(&self, _: Point<Points>, _: Duration) {}
        fn scroll(&self, _: Point<Points>, _: Point<Points>) {}
        fn drag(&self, _: Point<Points>, _: Point<Points>, _: DragOptions) -> Result<(), String> {
            Ok(())
        }
        fn type_text(&self, _: &str) {}
        fn key(&self, _: Key) {}
        fn input_text(&self, _: NodeId) -> Option<String> {
            None
        }
        fn back(&self) -> Result<(), String> {
            Err("no back here".into())
        }
        fn answer_dialog(&self, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn animating(&self) -> bool {
            false
        }
        fn opening(&self) -> bool {
            Instant::now() < *self.shows_at.lock().unwrap()
        }
        fn screenshot(&self) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn resize(&self, _: Points, _: Points) -> Result<(), String> {
            Ok(())
        }
        fn set_dark(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn quit(&self) {}
    }

    #[test]
    fn steps_wait_for_a_window_to_show_its_first_frame() {
        let (engine, batches) =
            crate::start(EngineConfig::new(crate::windowed_root::<Tally>())).unwrap();
        let model = Arc::new(Model::default());
        let feeding = model.clone();
        std::thread::spawn(move || {
            while let Ok(batch) = batches.recv() {
                feeding.apply(&batch);
            }
        });
        let scene = Arc::new(CountingScene::new(model.clone(), false));
        // The window shows well after the app's one batch is quiet, as a
        // window whose first frame does not come shows when its wait runs
        // out.
        let shows_at = Arc::new(Mutex::new(Instant::now() + QUIET * 3));
        let lost = Arc::new(Mutex::new(0));
        let agent = Agent::new(
            scene.clone(),
            Box::new(Opening {
                fake: Fake(engine.control(), Arc::default(), Some(model.clone())),
                shows_at: shows_at.clone(),
                lost: lost.clone(),
            }),
        );
        let ok = StepOutcome::Done {
            value: serde_json::Value::Null,
        };

        // `open` is done once the window shows, and the first press reaches
        // the app.
        assert_eq!(agent.take(TestStep::Ready { timeout_ms: 5000 }), ok);
        assert!(!agent.native.opening());
        assert_eq!(
            agent.take(TestStep::Press {
                selector: "Add".into(),
            }),
            ok
        );
        assert_eq!(*lost.lock().unwrap(), 0);
        assert_eq!(
            agent.take(TestStep::Texts),
            StepOutcome::Done {
                value: serde_json::json!(["Count: 1", "Add"])
            }
        );

        // Shown, the window holds no step back: the next one skips the
        // settle the last one ended with.
        scene.take_waits();
        agent
            .find("Add", "pressable view", PickTarget::Pressable)
            .unwrap();
        assert_eq!(scene.take_waits(), 0);

        // A window opening after a quiet step, without a batch, is waited
        // for before the next step acts.
        *shows_at.lock().unwrap() = Instant::now() + QUIET;
        agent
            .find("Add", "pressable view", PickTarget::Pressable)
            .unwrap();
        assert!(scene.take_waits() > 0);
        assert!(!agent.native.opening());

        drop(engine);
    }
}

#[cfg(test)]
#[path = "tests/drag_agent.rs"]
mod drag_tests;
