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
//! app is quiet: no batch and no native animation for 100 ms, 2 s at
//! most. [`Native`]'s calls come from that thread; implementations do
//! their work on the main thread and return when it is done.

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
use nsh_dev::protocol::{PickTarget, SceneQuery, SpanStyle, StepOutcome, TestStep};

mod forward;

pub use self::forward::{Outgoing, Send as SendOutgoing};
pub use crate::screen::Pick;
use crate::{MemoryStorage, screen::Screen, selector::Selector};

/// How far a dragging finger moves in a display frame, as headless drags
/// move it.
pub const DRAG_STEP: Points = Points(10.0);
/// A display frame, between a drag's moves.
pub const FRAME: Duration = Duration::from_millis(16);
/// How long a dragging finger rests where it lands before it moves, as a
/// hand does: the views under it hear it land (a JS responder takes it)
/// before a drag starts.
pub const LANDING: Duration = Duration::from_millis(100);

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

/// How long after the last batch the app is quiet.
const QUIET: Duration = Duration::from_millis(100);
/// How long a step waits for the app to be quiet at most.
const SETTLE: Duration = Duration::from_secs(2);
/// How often waits look again while nothing comes.
const POLL: Duration = Duration::from_millis(20);
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
/// How many gestures scrolling a view into view takes at most.
const SCROLLS_INTO_VIEW: usize = 20;

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
        state.screen.observe(batch);
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
        });
    }

    /// Sets `config`, the engine of a test session's app, up as the test
    /// says ([`Model::set_up`]; nothing before): its storage is the test's,
    /// its requests go to the test (which answers them or lets them through
    /// to the host's network), a traced app's engine logs each commit's
    /// timings, the environment keeps what the test fixed, the app's
    /// clipboard calls are served from the test's clipboard, and it runs on
    /// the test's manual clock when there is one (which also moves with the
    /// display's frames). The test plays the embedding app on the view's
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
    /// The one view `selector` names for a step on `target`.
    fn pick(&self, selector: &str, target: PickTarget) -> Result<Pick, String>;
    /// The scroll views around `id`, innermost first, and whether each
    /// scrolls horizontally.
    fn scroll_ancestors(&self, id: NodeId) -> Result<Vec<(NodeId, bool)>, String>;
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
    /// the agent moves as time passes in a step (a long press's hold).
    fn manual_clock(&self) -> bool {
        false
    }
    /// The embedding app sends event `name` to the app
    /// ([`Model::send_host_event`]).
    fn send_host_event(&self, name: &str, data: serde_json::Value) -> Result<(), String>;
    /// The URLs the app opened ([`Model::opened_urls`]).
    fn opened_urls(&self) -> Result<Vec<String>, String>;
}

impl Scene for Model {
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
        Ok(match target {
            PickTarget::Pressable => screen.pressable(&parsed),
            PickTarget::LongPressable => screen.long_pressable(&parsed),
            PickTarget::Input => screen.input_view(&parsed),
            PickTarget::ScrollView => screen.scroll_view(&parsed),
            PickTarget::View => screen.view(&parsed),
        })
    }
    fn scroll_ancestors(&self, id: NodeId) -> Result<Vec<(NodeId, bool)>, String> {
        Ok(self.lock().screen.scroll_ancestors(id))
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
            }),
            MenuValue::Submenu {
                label,
                enabled,
                items,
            } => MenuItem::Submenu {
                label,
                enabled,
                items: items.into_iter().map(MenuValue::into_item).collect(),
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
            SceneQuery::Pick { selector, target } => model.pick(selector, *target).map(pick_value),
            SceneQuery::ScrollAncestors { id } => {
                model.scroll_ancestors(*id).and_then(|a| json(to_value(a)))
            }
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
}

impl RemoteScene {
    /// Asks through `ask`, which takes a step on the host and gives its
    /// value.
    pub fn new(
        ask: impl Fn(TestStep) -> Result<serde_json::Value, String> + Send + Sync + 'static,
    ) -> Self {
        RemoteScene { ask: Box::new(ask) }
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
    /// The view `id`'s bounds in the window's content, in points from its
    /// top-left (`None`: it has no native view on screen).
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>>;
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
    /// button) down at `from`, resting there for [`LANDING`], moving along
    /// [`drag_path`] a display frame at a time and lifting at `to` at once,
    /// still moving, as a quick drag does.
    fn drag(&self, from: Point<Points>, to: Point<Points>);
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
    /// a paste into it needs no press (one would move its caret).
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
    /// Presses `keys`, a keystroke as `nsh/keymap` names it (`"mod+k"`;
    /// `mod` the platform's command key), on a hardware keyboard: the app's
    /// shortcuts hear it, else what has the keyboard focus. Every
    /// platform's agent makes them; one that cannot refuses it.
    fn press_keys(&self, keys: &str) -> Result<(), String> {
        let _ = keys;
        Err("this platform's test agent presses no hardware keys: run the test headless".into())
    }
    /// Drags from `from` to `to` as [`Native::drag`] does, keeping the
    /// button down until [`Native::drop_at`].
    fn drag_and_hold(&self, from: Point<Points>, to: Point<Points>) -> Result<(), String> {
        let _ = (from, to);
        Err("`dragAndHold` runs headless and on Linux for now".into())
    }
    /// Drops local files (`file:` URLs) at `at`, as a file manager's drag
    /// does.
    fn drop_files(&self, at: Point<Points>, uris: Vec<String>) -> Result<(), String> {
        let _ = (at, uris);
        Err("`dropFiles` runs headless and on Linux for now".into())
    }
    /// Lets go of the button [`Native::drag_and_hold`] holds, at `at`.
    fn drop_at(&self, at: Point<Points>) -> Result<(), String> {
        let _ = at;
        Err("`drop` runs headless and on Linux for now".into())
    }
    /// Holds modifier keys down (`down`) or lets go of them: the presses,
    /// drags and hovers until then carry them. One that cannot refuses it.
    fn hold_keys(&self, keys: &str, down: bool) -> Result<(), String> {
        let _ = (keys, down);
        Err(
            "holding keys (`keyboard.down` / `keyboard.up`) runs headless and on Linux for now"
                .into(),
        )
    }
    /// Types `text` into the focused input, key by key.
    fn type_text(&self, text: &str);
    /// Presses `key`.
    fn key(&self, key: Key);
    /// The text of input `id` as the platform holds it.
    fn input_text(&self, id: NodeId) -> Option<String>;
    /// Goes back as the user does (a back gesture, the back button,
    /// Escape): an error when the platform has none.
    fn back(&self) -> Result<(), String>;
    /// Answers the dialog the app shows now (the oldest): presses its
    /// button with the text `button`, or closes it without one.
    fn answer_dialog(&self, button: Option<&str>) -> Result<(), String>;
    /// Whether a native animation runs now.
    fn animating(&self) -> bool;
    /// A picture of the window, as a PNG.
    fn screenshot(&self) -> Result<Vec<u8>, String>;
    /// Makes the window `size` points.
    fn resize(&self, width: Points, height: Points) -> Result<(), String>;
    /// Switches the appearance the app sees.
    fn set_dark(&self, dark: bool) -> Result<(), String>;
    /// Closes the app: the host exits.
    fn quit(&self);
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

/// Takes test steps on a host's app ([`Model`], [`Native`]).
pub struct Agent {
    scene: std::sync::Arc<dyn Scene>,
    native: Box<dyn Native>,
    /// The window's size the scene was told last.
    viewport: Mutex<Option<Size<Points>>>,
    /// Where a `dragAndHold` left the pointer down.
    held: Mutex<Option<Point<Points>>>,
}

impl Agent {
    /// An agent on the app `scene` sees, acting through `native`.
    pub fn new(scene: std::sync::Arc<dyn Scene>, native: Box<dyn Native>) -> Agent {
        Agent {
            scene,
            native,
            viewport: Mutex::new(None),
            held: Mutex::new(None),
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
            TestStep::Drag { selector, x, y } => done(self.drag(&selector, x, y)),
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
            TestStep::DragAndHold { selector, x, y } => done(self.drag_and_hold(&selector, x, y)),
            TestStep::Drop => done(self.drop_held()),
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
            TestStep::Wait { ms } => {
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
                let seen = self.scene.activity()?.batches;
                self.scene
                    .wait_for_batch(seen, Duration::from_millis(timeout_ms));
                done(self.check())
            }
            TestStep::Texts => Ok(Value::from(self.scene.texts()?)),
            TestStep::Count { selector } => Ok(Value::from(self.scene.count(&selector)?)),
            TestStep::Shows { selector } => Ok(Value::from(self.scene.matches(&selector)?)),
            TestStep::Enabled { selector } => Ok(Value::from(self.scene.enabled(&selector)?)),
            TestStep::SpanStyle { selector } => {
                serde_json::to_value(self.scene.span_style(&selector)?).map_err(|e| e.to_string())
            }
            TestStep::Value { selector } => {
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
                self.native.quit();
                Ok(Value::Null)
            }
            TestStep::Scene { query } => self.scene_query(query),
        }
    }

    /// Tells the scene the window's size when it changed.
    fn sync_viewport(&self) -> Result<(), String> {
        let size = self.native.viewport();
        let mut told = self.viewport.lock().unwrap_or_else(|e| e.into_inner());
        if *told != Some(size) {
            self.scene.set_viewport(size)?;
            *told = Some(size);
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
            SceneQuery::Pick { selector, target } => scene.pick(&selector, target).map(pick_value),
            SceneQuery::ScrollAncestors { id } => {
                scene.scroll_ancestors(id).and_then(|a| json(to_value(a)))
            }
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
            return Err(format!(
                "the app rendered nothing in {} s",
                timeout.as_secs()
            ));
        }
        self.settled()
    }

    /// The one view `pick` gave for `selector` (from [`Self::find`]).
    fn picked(&self, pick: Pick, selector: &str, what: &str) -> Result<NodeId, String> {
        match pick {
            Pick::One(id) => Ok(id),
            Pick::None => Err(format!(
                "no {what} matches `{selector}`; {}",
                self.on_screen()
            )),
            Pick::Many(n) => Err(format!(
                "`{selector}` matches {n} {what}s: say which (`{selector} >> nth=0`), or look inside \
                 a view around it (`id:list >> {selector}`)"
            )),
            Pick::Disabled => Err(format!(
                "`{selector}` {}; {}",
                crate::screen::disabled(what),
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
        self.settled()?;
        let picked = self.scene.pick(selector, target)?;
        let id = self.picked(picked, selector, what)?;
        if let Some((canvas, center)) = self.scene.canvas_node(selector)? {
            return Ok((
                id,
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
            let at = match inner {
                Some(inner) if self.native.bounds(inner).is_some() => {
                    self.scroll_into_view(inner, selector)?
                }
                _ => self.scroll_into_view(id, selector)?,
            };
            return Ok((id, at));
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
        Ok((id, at.center()))
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
        let mut before: Option<Point<Points>> = None;
        // Where in the scroll view the gestures start, along its length: its
        // middle, else (when what is there scrolls by itself, a text area)
        // elsewhere, as a user moves the finger.
        let mut anchors = [0.5f32, 0.25, 0.75].into_iter().peekable();
        for _ in 0..SCROLLS_INTO_VIEW {
            let bounds = self.native.bounds(id).ok_or_else(not_on_screen)?;
            let at = local.map_or(bounds.center(), |p| bounds.origin + p);
            let viewport = self.native.viewport();
            let window = Bounds::new(Point::new(Points(0.0), Points(0.0)), viewport);
            if let Some(b) = before
                && (b.x.0 - at.x.0).abs() < 1.0
                && (b.y.0 - at.y.0).abs() < 1.0
            {
                anchors.next();
                // No gesture moves it any more (its scroll view's end): it
                // is pressed where it is when it shows.
                if anchors.peek().is_none() {
                    return if window.contains(&at) {
                        Ok((at, before.is_some()))
                    } else {
                        Err(not_on_screen())
                    };
                }
            }
            // The innermost scroll view whose bounds leave the middle out,
            // or near their edge (where a finger does not press and bars,
            // the home indicator and fades sit), else the outermost one
            // when the window does.
            let hiding = scrollers.iter().find_map(|&(scroller, horizontal)| {
                let b = self.native.bounds(scroller)?;
                (!well_inside(&b, at, horizontal)).then_some((scroller, horizontal, b))
            });
            let hiding = hiding.or_else(|| {
                let &(s, h) = scrollers.last()?;
                (!well_inside(&window, at, h)).then_some(())?;
                Some((s, h, self.native.bounds(s)?))
            });
            let Some((_, horizontal, scroller)) = hiding else {
                if window.contains(&at) {
                    return Ok((at, before.is_some()));
                }
                return Err(not_on_screen());
            };
            let along = anchors.peek().copied().unwrap_or(0.5);
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
            // A finger dragging it stays inside it: as far as the nearer
            // edge less a tenth.
            let room = extent * (along.min(1.0 - along) - 0.1).max(0.1);
            let step = distance.clamp(-room, room);
            let delta = if horizontal {
                Point::new(Points(step), Points(0.0))
            } else {
                Point::new(Points(0.0), Points(step))
            };
            self.native.scroll(middle, delta);
            self.stopped(id)?;
            before = Some(at);
        }
        Err(format!(
            "`{selector}` did not come into view; {}",
            self.on_screen()
        ))
    }

    fn press(&self, selector: &str) -> Result<(), String> {
        let (_, at) = self.find(selector, "pressable view", PickTarget::Pressable)?;
        self.native.press(at);
        self.settled()
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
        let (_, at) = self.find(selector, "input", PickTarget::Input)?;
        self.native.press(at);
        self.settled()
    }

    fn type_text(&self, selector: &str, text: &str) -> Result<(), String> {
        self.focus(selector)?;
        // A line break is the return key, as the headless driver types it.
        for (i, line) in text.split('\n').enumerate() {
            if i > 0 {
                self.native.key(Key::Return);
            }
            if !line.is_empty() {
                self.native.type_text(line);
            }
        }
        self.settled()
    }

    fn submit(&self, selector: &str) -> Result<(), String> {
        self.focus(selector)?;
        self.native.key(Key::Return);
        self.settled()
    }

    fn clear(&self, selector: &str) -> Result<(), String> {
        self.focus(selector)?;
        self.native.key(Key::SelectAll);
        self.native.key(Key::Backspace);
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
        let items = self.scene.menu()?.ok_or("no context menu is open")?;
        crate::menu::find(&items, label)?;
        self.native.choose_menu_item(&crate::menu::path(label))?;
        self.scene.menu_closed()?;
        self.settled()
    }

    fn close_menu(&self) -> Result<(), String> {
        if self.scene.menu()?.is_none() {
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

    fn drag_and_hold(&self, selector: &str, x: f32, y: f32) -> Result<(), String> {
        self.drop_held().ok();
        let (_, at) = self.find(selector, "view", PickTarget::View)?;
        let to = Point::new(at.x + Points(x), at.y + Points(y));
        self.native.drag_and_hold(at, to)?;
        *self.held.lock().unwrap() = Some(to);
        self.settled()
    }

    fn drop_held(&self) -> Result<(), String> {
        let at = self
            .held
            .lock()
            .unwrap()
            .take()
            .ok_or("`drop()` comes after `dragAndHold`: no pointer is down")?;
        self.native.drop_at(at)?;
        self.settled()
    }

    fn drag(&self, selector: &str, x: f32, y: f32) -> Result<(), String> {
        let (_, at) = self.find(selector, "view", PickTarget::View)?;
        let to = Point::new(at.x + Points(x), at.y + Points(y));
        self.native.drag(at, to);
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

    fn wait_for(&self, selector: &str, timeout: Duration, gone: bool) -> Result<(), String> {
        Selector::parse(selector)?;
        let deadline = Instant::now() + timeout;
        loop {
            let seen = self.scene.activity()?.batches;
            let holds = self.scene.matches(selector)? != gone;
            self.check()?;
            if holds {
                return Ok(());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                let what = if gone { "gone" } else { "showing" };
                return Err(format!(
                    "`{selector}` {what} never happened in {} ms; {}",
                    timeout.as_millis(),
                    self.on_screen()
                ));
            }
            self.scene.wait_for_batch(seen, left.min(POLL * 5));
        }
    }

    /// Waits until the app is quiet ([`QUIET`], no native animation),
    /// [`SETTLE`] at most, then fails if it threw meanwhile.
    fn settled(&self) -> Result<(), String> {
        let start = Instant::now();
        // When an animation last ran: what it ends with (a screen popped
        // once it slid out) comes after it.
        let mut moved = start;
        let mut first = None;
        loop {
            let activity = self.scene.activity()?;
            let first = *first.get_or_insert(activity.batches);
            if self.native.animating() {
                moved = Instant::now();
            }
            // Quiet since the step began, the last batch and the last
            // animation.
            let since = activity
                .since_last
                .map_or(start.elapsed(), |d| d.min(start.elapsed()))
                .min(moved.elapsed());
            if since >= QUIET {
                break;
            }
            if start.elapsed() >= SETTLE {
                // The step goes on all the same; why it waited this long
                // tells why a run is slow.
                log::info!(
                    "test agent: the app did not settle in {} s: {} batches came, an animation ran {} ms ago",
                    SETTLE.as_secs(),
                    activity.batches - first,
                    moved.elapsed().as_millis()
                );
                break;
            }
            self.scene.wait_for_batch(activity.batches, POLL);
        }
        self.check()
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
        format!("on screen: {:?}", self.scene.texts().unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use nsh_core::{
        EventKind, EventPayload,
        element::Root,
        geometry::{Size, point},
        prelude::*,
    };
    use nsh_engine::{EngineConfig, EngineControl};

    use super::*;

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
        fn drag(&self, _: Point<Points>, _: Point<Points>) {}
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
        let (engine, _batches) = crate::start(EngineConfig::new(Root::of::<Tally>())).unwrap();
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

    #[test]
    fn the_agent_finds_views_in_the_model_and_acts_where_they_are() {
        let (engine, batches) = crate::start(EngineConfig::new(Root::of::<Tally>())).unwrap();
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
        // No input to type into.
        assert!(matches!(
            agent.take(TestStep::Type { selector: "Add".into(), text: "x".into() }),
            StepOutcome::Failed { message } if message.starts_with("no input matches `Add`")
        ));
        assert!(typed.lock().unwrap().is_empty());
        drop(engine);
    }
}
