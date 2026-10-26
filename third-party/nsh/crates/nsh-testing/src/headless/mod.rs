//! Headless runs: an app on an engine with no platform, driven by steps a
//! user's hands would take, its mount batches seen as they come.
//!
//! [`Headless`] is the driver: it starts an app on an engine with display
//! frames at 60 Hz ([`start`]), applies its batches to a model of the
//! native views ([`Screen`]) and takes steps on what they show, named by
//! selectors (`id:save`, `label:Close`, `text:+1`, `view:12`, or a bare
//! string): [`Headless::press`], [`Headless::type_text`],
//! [`Headless::submit`], [`Headless::scroll`], [`Headless::wait`],
//! [`Headless::wait_for`]. Each step delivers the events a platform
//! would, in its order, and fails with what is on screen when it cannot
//! be taken or when the app throws. An observer ([`Headless::observe`])
//! sees every batch with the step it came in ([`print_batch`] prints it as
//! `nsh test --trace` does). [`StubNetwork`] and
//! [`MemoryStorage`](crate::MemoryStorage) stand in for the device's
//! network and storage.
//!
//! On a manual clock (`EngineConfig::clock`) the app's time moves only as
//! the driver moves it: display frames come at once, one frame's time
//! apart, while the app asks for them or a native animation runs (so steps
//! finish animations without waiting for them), [`Headless::wait`] and a
//! long press move the clock by their time, and [`Headless::run_for`] /
//! [`Headless::fast_forward`] move it as a test says. What the driver
//! waits for (a step's quiet, a `waitFor`'s timeout) stays real time.
//!
//! `nsh test` runs apps this way (feature `js`: [`crate::run_file`]),
//! printing the batches under their steps with `--trace`; so do Rust tests
//! of an app's crate, which need no QuickJS for a Rust root.

mod animation;
mod keyboard;
#[cfg(feature = "live")]
mod live;
mod menus;
mod net;
mod pointer;
mod stub;

use std::{
    io::Write,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{
    ApproxTextEngine, Command, Dialog, DialogButtonStyle, EventKind, EventPayload, MountBatch,
    MountItem, NodeId, PayloadValue, Point, Points, PressEvent, ROOT_ID, Size, SubmitBehavior,
    geometry::{point, px},
};
use nsh_engine::{
    AppError, AppErrorKind, Clock, Engine, EngineConfig, EngineControl, Environment, MountSink,
};

use self::animation::{Animator, FRAME};
#[cfg(feature = "live")]
pub use self::live::UreqNetwork;
pub use self::{
    net::DirectoryAssets,
    stub::{RecordingNetwork, StubHandler, StubNetwork, StubReply, StubResponse, StubRoute},
};
use crate::{
    screen::{self, Back, Contact, InputResult, Pick, Screen},
    selector::Selector,
};

/// How long [`Headless::wait_for`] and [`Headless::wait_until`] wait by
/// default, and a first render at most.
pub const WAIT: Duration = Duration::from_secs(5);
/// How long the app must render nothing after a step for it to be done.
const QUIET: Duration = Duration::from_millis(100);
/// How long a step waits for the app to be quiet at most: an app with a
/// running timer or animation never is.
const SETTLE: Duration = Duration::from_secs(2);
/// How long [`Headless::idle`] may take at most.
const MAX_IDLE: Duration = Duration::from_secs(10);
/// How far a scroll moves per display frame, in points.
const SCROLL_STEP: Points = Points(10.0);

struct ChannelSink {
    batches: Sender<MountBatch>,
    errors: Sender<AppError>,
    /// Set once the engine runs; drives `requestAnimationFrame` at 60 Hz.
    control: Arc<OnceLock<EngineControl>>,
    /// On a manual clock: the engine asked for a frame, which the driver
    /// gives it when it moves the clock ([`Headless`]).
    wanted: Option<Arc<AtomicBool>>,
}

impl MountSink for ChannelSink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.batches.send(batch);
    }

    fn report(&self, error: &AppError) {
        let _ = self.errors.send(error.clone());
    }

    fn request_frame(&self) {
        if let Some(wanted) = &self.wanted {
            wanted.store(true, Ordering::Relaxed);
            return;
        }
        let control = self.control.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FRAME);
            if let Some(control) = control.get() {
                control.frame();
            }
        });
    }
}

/// Starts `config`'s app on an engine with no platform that gets display
/// frames at 60 Hz while it asks for them, as on screen (timers,
/// animations and what waits for a frame run), laying text out with
/// [`ApproxTextEngine`]: the engine, and the batches it sends.
pub fn start(config: EngineConfig) -> std::io::Result<(Engine, Receiver<MountBatch>)> {
    launch(config).map(|launched| (launched.engine, launched.batches))
}

/// A started engine and what it sends.
struct Launched {
    engine: Engine,
    batches: Receiver<MountBatch>,
    errors: Receiver<AppError>,
    /// On a manual clock: it asked for a frame.
    wanted: Option<Arc<AtomicBool>>,
}

fn launch(config: EngineConfig) -> std::io::Result<Launched> {
    let (batches, batches_rx) = crossbeam_channel::unbounded();
    let (errors, errors_rx) = crossbeam_channel::unbounded();
    let control = Arc::new(OnceLock::new());
    let wanted = config.clock.is_manual().then(Arc::default);
    let sink = ChannelSink {
        batches,
        errors,
        control: control.clone(),
        wanted: wanted.clone(),
    };
    let engine = Engine::start(config, || ApproxTextEngine, sink)?;
    let _ = control.set(engine.control());
    Ok(Launched {
        engine,
        batches: batches_rx,
        errors: errors_rx,
        wanted,
    })
}

/// Sees each batch a [`Headless`] applies, with the step it came in.
type Observer = Box<dyn FnMut(&str, &MountBatch) + Send>;

/// Answers a dialog ([`Headless::on_dialog`]).
type DialogHandler = Box<dyn FnMut(&Dialog) -> DialogAnswer + Send>;

/// Takes the app's `nsh/host` calls ([`Headless::on_host_call`]): their
/// id, the host's function and its argument.
#[cfg(feature = "js")]
type HostCalls = Box<dyn FnMut(u64, &str, &nsh_core::JsonValue) + Send>;

/// The answer to a dialog (`AlertDialog.show`, an action sheet).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogAnswer {
    /// Press the button with this text.
    Press(String),
    /// Close it without a button (tapping outside, the back button).
    Dismiss,
}

/// Answers a pick: the files the user picks for the request (none: the
/// picker cancelled).
type PickHandler =
    Box<dyn FnMut(&nsh_core::picker::PickRequest) -> Vec<nsh_core::picker::PickedFile> + Send>;

/// Who answers the picks a step asks for.
enum Picks {
    /// Cancelled: no files.
    Default,
    /// A test's handler.
    Handler(PickHandler),
    /// The caller, after the step ([`Headless::answer_pick`]).
    Caller,
}

/// Who answers the dialogs a step shows.
enum Dialogs {
    /// [`default_answer`].
    Default,
    /// A test's handler.
    Handler(DialogHandler),
    /// The caller, after the step ([`Headless::answer_dialog`]).
    Caller,
}

/// What [`Headless::pump`] saw.
enum Pumped {
    /// A batch, applied.
    Batch,
    /// The app threw.
    Error,
    /// The deadline passed, or a frame on the manual clock brought
    /// nothing.
    Timeout,
    /// The app left: nothing more comes.
    Exited,
}

/// How soon a press follows the last on the same view to count as its next
/// click: the platforms' default double-click time.
const CLICK_INTERVAL: Duration = Duration::from_millis(500);

/// An app on a headless engine ([`start`]) and what it shows ([`Screen`]),
/// driven by steps: press views, type into inputs, scroll, go back, wait
/// for what it shows.
///
/// ```ignore
/// let mut app = Headless::start(EngineConfig::new(Root::of::<my_app::App>())).unwrap();
/// app.wait_for("Count: 0")?;
/// app.press("Tap")?;
/// app.wait_for("Count: 1")?;
/// ```
///
/// A step takes the batches that came since the last one first (they
/// belong to it), then names itself the step of the batches that follow:
/// what [`Headless::observe`] sees. Steps that act on the app return once
/// it rendered nothing for 100 ms and no native animation runs (2 s at
/// most), and fail when the app threw meanwhile (an exception that
/// escaped a callback, a bundle that did not load, a VM that was stopped)
/// or asked what only a real platform answers (an image from the
/// clipboard).
///
/// It plays the platform's part the NSH protocol defines and nothing
/// else: the native animation graph runs frame by frame (nsh-core's `animation`),
/// a back pops screens and closes modals, dialogs are answered (by the
/// test, else [`default_answer`]), the clipboard holds text, and `nsh
/// test`'s web page host answers `nsh/host` calls. Images are
/// not loaded: no `onLoad` comes, and `Image.getSize` / `Image.prefetch`
/// fail.
pub struct Headless {
    engine: Engine,
    batches: Receiver<MountBatch>,
    errors: Receiver<AppError>,
    /// The app's errors seen while waiting, for the next check.
    seen: Vec<AppError>,
    screen: Screen,
    animator: Animator,
    dialogs: Dialogs,
    /// Who answers the picks.
    picks: Picks,
    step: String,
    applied: u64,
    /// The app left (`process.exit`, `Command::ExitApp`): no more batches
    /// come, and waits end.
    exited: bool,
    /// The surface's environment and size, as the platform last reported.
    environment: Environment,
    viewport: Size<Points>,
    observer: Option<Observer>,
    /// The app's clock.
    clock: Clock,
    /// On a manual clock: the engine asked for a frame.
    wanted: Option<Arc<AtomicBool>>,
    /// The embedding app's channel with the app (`EngineConfig::host`),
    /// which the test plays.
    host: nsh_engine::HostChannel,
    /// The last press: its view and when, for counting a double press as
    /// the platforms do ([`CLICK_INTERVAL`]).
    last_press: Option<(NodeId, nsh_core::time::Instant, u32)>,
    /// Where the app's `nsh/host` calls go (the web page's host).
    #[cfg(feature = "js")]
    host_calls: Option<HostCalls>,
}

impl Headless {
    /// Starts `config`'s app ([`start`]).
    pub fn start(config: EngineConfig) -> std::io::Result<Headless> {
        let environment = config.environment;
        let viewport = config.viewport;
        let clock = config.clock.clone();
        let host = config.host.clone();
        let Launched {
            engine,
            batches,
            errors,
            wanted,
        } = launch(config)?;
        let mut screen = Screen::default();
        screen.set_viewport(viewport);
        Ok(Headless {
            engine,
            batches,
            errors,
            seen: Vec::new(),
            screen,
            animator: Animator::new(clock.clone()),
            dialogs: Dialogs::Default,
            picks: Picks::Default,
            step: "open".to_owned(),
            applied: 0,
            exited: false,
            environment,
            viewport,
            observer: None,
            clock,
            wanted,
            host,
            last_press: None,
            #[cfg(feature = "js")]
            host_calls: None,
        })
    }

    /// The app's clock (`EngineConfig::clock`).
    pub fn clock(&self) -> &Clock {
        &self.clock
    }

    /// The step `clock.runFor(<ms>)`: moves the app's manual clock by
    /// `time`, a display frame at a time (timers, frames and native
    /// animations run as they come due), then settles.
    pub fn run_for(&mut self, time: Duration) -> Result<(), String> {
        self.manual_clock("runFor")?;
        self.step(format!("clock.runFor({})", time.as_millis()));
        self.elapse(time);
        self.done()
    }

    /// The step `clock.fastForward(<ms>)`: moves the app's manual clock by
    /// `time` at once, as a device waking from sleep does: the timers due
    /// meanwhile run once each, then the app settles.
    pub fn fast_forward(&mut self, time: Duration) -> Result<(), String> {
        self.manual_clock("fastForward")?;
        self.step(format!("clock.fastForward({})", time.as_millis()));
        self.clock.advance_to(self.clock.now() + time);
        self.advance(Duration::ZERO);
        self.done()
    }

    /// Sets the wall time of the app's manual clock (`Date.now()`) to `at`,
    /// without moving its timers.
    pub fn set_system_time(&mut self, at: std::time::SystemTime) -> Result<(), String> {
        self.manual_clock("setSystemTime")?;
        self.clock.set_system_time(at);
        Ok(())
    }

    /// An error unless the app's clock is manual.
    fn manual_clock(&self, what: &str) -> Result<(), String> {
        if self.clock.is_manual() {
            Ok(())
        } else {
            Err(format!(
                "clock.{what} needs a manual clock: open the app with one (`open(entry, {{ clock: {{}} }})`)"
            ))
        }
    }

    /// Moves the manual clock by `by` and waits until the engine got
    /// there (its batches sent).
    fn advance(&self, by: Duration) {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.engine.control().advance_clock(by, move || {
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(MAX_IDLE);
    }

    /// One display frame on the manual clock, `by` after the last: the
    /// clock moves, then the frame comes if the engine asked for one, and
    /// the native animations take it.
    fn frame(&mut self, by: Duration) {
        self.advance(by);
        if self
            .wanted
            .as_ref()
            .is_some_and(|w| w.swap(false, Ordering::Relaxed))
        {
            self.engine.control().frame();
            self.advance(Duration::ZERO);
        }
        self.animator.tick();
        self.report_finished();
    }

    /// Whether, on a manual clock, the app wants frames: it asked for one,
    /// or a native animation runs.
    fn wants_frames(&self) -> bool {
        self.wanted
            .as_ref()
            .is_some_and(|w| w.load(Ordering::Relaxed))
            || (self.clock.is_manual() && self.animator.running())
    }

    /// Lets the app's time pass by `time`: real time on the system's clock,
    /// the manual clock moved a frame at a time otherwise; batches are
    /// applied as they come.
    fn elapse(&mut self, time: Duration) {
        if !self.clock.is_manual() {
            let end = Instant::now() + time;
            while Instant::now() < end {
                if let Pumped::Exited = self.pump(end) {
                    return;
                }
            }
            return;
        }
        let end = self.clock.now() + time;
        while !self.exited && self.clock.now() < end {
            let by = end.saturating_duration_since(self.clock.now()).min(FRAME);
            self.frame(by);
            self.drain();
        }
    }

    /// The embedding app's channel with the app (`nsh/host`): its launch
    /// parameters and handlers, as the engine was given them.
    pub fn host(&self) -> &nsh_engine::HostChannel {
        &self.host
    }

    /// The step `host.send`: the embedding app sends event `name` with
    /// `data` (the app's `host.on(name, ...)` hears it), and the app
    /// settles.
    pub fn send_host_event(&mut self, name: &str, data: nsh_core::JsonValue) -> Result<(), String> {
        self.step(format!("host.send({name})"));
        self.host.send(name, data)?;
        self.done()
    }

    /// The step `setViewport(<w>, <h>)`: the surface becomes `size` (a
    /// rotation, a resized window), as a platform reports it.
    pub fn set_viewport(&mut self, size: Size<Points>) -> Result<(), String> {
        self.step(format!("setViewport({}, {})", size.width, size.height));
        self.viewport = size;
        self.screen.set_viewport(size);
        self.environment.window = size;
        self.engine.control().resize(size);
        self.engine.control().set_environment(self.environment);
        self.done()
    }

    /// The step `setEnvironment`: the surface's environment changes as
    /// `change` says (dark mode, the locale), as a platform reports it.
    pub fn set_environment(
        &mut self,
        what: &str,
        change: impl FnOnce(&mut Environment),
    ) -> Result<(), String> {
        self.step(what);
        change(&mut self.environment);
        self.engine.control().set_environment(self.environment);
        self.done()
    }

    /// The engine: [`Engine::control`] sends it input.
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// What is on screen, from the batches applied so far.
    pub fn screen(&self) -> &Screen {
        &self.screen
    }

    /// The engine and the batches not applied yet, for a model of the
    /// test's own.
    pub fn into_parts(self) -> (Engine, Receiver<MountBatch>) {
        (self.engine, self.batches)
    }

    /// Calls `observer` with each batch applied from now on and the step
    /// it came in (`open` until the first step).
    pub fn observe(&mut self, observer: impl FnMut(&str, &MountBatch) + Send + 'static) {
        self.observer = Some(Box::new(observer));
    }

    /// Answers the dialogs steps show with `handler`, instead of
    /// [`default_answer`].
    pub fn on_dialog(&mut self, handler: impl FnMut(&Dialog) -> DialogAnswer + Send + 'static) {
        self.dialogs = Dialogs::Handler(Box::new(handler));
    }

    /// Leaves the dialogs steps show to the caller: a step returns with
    /// one shown ([`Headless::pending_dialog`]) until
    /// [`Headless::answer_dialog`] answers it.
    pub fn answer_dialogs_myself(&mut self) {
        self.dialogs = Dialogs::Caller;
    }

    /// The oldest dialog shown and not answered yet.
    pub fn pending_dialog(&self) -> Option<&Dialog> {
        self.screen.pending_dialog()
    }

    /// Answers the oldest dialog not answered yet with `answer`, as the
    /// user would, then waits until the app is quiet; an error for a
    /// button it has not, or a dialog that cannot be dismissed.
    pub fn answer_dialog(&mut self, answer: DialogAnswer) -> Result<(), String> {
        self.answer(answer)?;
        self.done()
    }

    /// Answers the picks steps ask for (`Picker.pickImages`) with
    /// `handler`, the files the user picks, instead of cancelling them.
    pub fn on_pick(
        &mut self,
        handler: impl FnMut(&nsh_core::picker::PickRequest) -> Vec<nsh_core::picker::PickedFile>
        + Send
        + 'static,
    ) {
        self.picks = Picks::Handler(Box::new(handler));
    }

    /// Leaves the picks steps ask for to the caller: a step returns with
    /// one asked ([`Headless::pending_pick`]) until [`Headless::answer_pick`]
    /// answers it.
    pub fn answer_picks_myself(&mut self) {
        self.picks = Picks::Caller;
    }

    /// The oldest pick asked and not answered yet.
    pub fn pending_pick(&self) -> Option<nsh_core::picker::PickRequest> {
        self.screen.pending_pick().map(|(_, request)| request)
    }

    /// The picks the app asked for so far, in order.
    pub fn picks(&self) -> Vec<nsh_core::picker::PickRequest> {
        self.screen.picks()
    }

    /// Answers the oldest pick not answered yet with `files` (none: the
    /// user cancelled), then waits until the app is quiet.
    pub fn answer_pick(&mut self, files: Vec<nsh_core::picker::PickedFile>) -> Result<(), String> {
        self.pick(files)?;
        self.done()
    }

    /// Answers the oldest pick not answered yet.
    fn pick(&mut self, files: Vec<nsh_core::picker::PickedFile>) -> Result<(), String> {
        let (id, _) = self.screen.pending_pick().ok_or("no pick to answer")?;
        self.screen.picked();
        self.engine.control().dispatch_event(
            ROOT_ID,
            EventKind::Pick,
            EventPayload::Picked { id, files },
        );
        Ok(())
    }

    /// Sends the app's `nsh/host` calls (the root's `Command::HostCall`) to
    /// `calls` as their batches are applied; the environment must say the
    /// platform has a host (`Environment::host`), else the core rejects
    /// them before they reach a batch.
    #[cfg(feature = "js")]
    pub(crate) fn on_host_call(
        &mut self,
        calls: impl FnMut(u64, &str, &nsh_core::JsonValue) + Send + 'static,
    ) {
        self.host_calls = Some(Box::new(calls));
    }

    /// Puts `text` on the clipboard (`None`: nothing), as the user copying.
    pub fn set_clipboard(&mut self, text: Option<String>) {
        self.screen.set_clipboard(text);
    }

    /// Takes the batches that came, then names the step of those that
    /// follow.
    pub fn step(&mut self, name: impl Into<String>) {
        self.drain();
        self.step = name.into();
    }

    /// The batches applied so far.
    pub fn applied(&self) -> u64 {
        self.applied
    }

    fn apply(&mut self, batch: &MountBatch) {
        let focused = self
            .screen
            .focused()
            .or(self.screen.key_focus())
            .filter(|old| {
                !batch
                    .items
                    .iter()
                    .any(|item| matches!(item, MountItem::Delete { id } if id == old))
            });
        self.screen.apply(batch);
        // The app moved the focus (`focus()`, `blur()`): platforms tell the
        // views as when the user moves it.
        let now = self.screen.focused().or(self.screen.key_focus());
        if now != focused {
            self.engine
                .control()
                .set_focus_path(self.screen.focus_path());
            if let Some(old) = focused {
                self.set_focused_state(old, false);
                self.send(old, EventKind::Blur, EventPayload::None);
            }
            if let Some(new) = now {
                self.send(new, EventKind::Focus, EventPayload::None);
            }
        }
        self.exited |= batch.items.iter().any(|item| {
            matches!(
                item,
                MountItem::Command {
                    command: Command::ExitApp,
                    ..
                }
            )
        });
        for item in &batch.items {
            self.animator.apply(item);
        }
        #[cfg(feature = "js")]
        if let Some(calls) = &mut self.host_calls {
            for item in &batch.items {
                if let MountItem::Command {
                    id: ROOT_ID,
                    command: Command::HostCall { id, name, args },
                } = item
                {
                    calls(*id, name, args);
                }
            }
        }
        self.applied += 1;
        if let Some(observer) = &mut self.observer {
            observer(&self.step, batch);
        }
        self.react();
    }

    /// Does what a platform does after a batch: reports where commands
    /// moved scroll views, tells modals they show, answers clipboard reads
    /// and the URLs opened, goes back when the app asked, reports finished
    /// animations.
    fn react(&mut self) {
        let control = self.engine.control();
        for result in self.screen.take_input_results() {
            match result {
                InputResult::CancelTouch(id) => control.cancel_touch(id),
                InputResult::SetStates(id, states) => control.set_states(id, states),
                InputResult::RetireListCell {
                    id,
                    request,
                    focus_path,
                } => {
                    let retired = focus_path.is_none();
                    if let Some(path) = focus_path {
                        control.set_focus_path(path);
                    }
                    control.retire_list_cell(id, request, retired);
                }
            }
        }
        // A later source removal in the same batch may have revoked a focus
        // that refused retirement earlier in that batch.
        control.set_focus_path(self.screen.focus_path());
        for id in self.screen.take_scrolled() {
            if let Some(scroll) = self.screen.scroll(id) {
                let (x, y) = (scroll.x, scroll.y);
                control.scroll(id, point(x, y), scroll.applied);
                self.animator.scrolled(id, point(x, y));
            }
        }
        for modal in self.screen.take_presented() {
            self.send(modal, EventKind::Show, EventPayload::None);
        }
        for (id, has_only) in self.screen.take_clipboard_reads() {
            let text = self.screen.clipboard().map(str::to_owned);
            let mut fields = vec![
                ("id", PayloadValue::Number(f64::from(id))),
                ("has", PayloadValue::Bool(text.is_some())),
            ];
            if let Some(text) = text.filter(|_| !has_only) {
                fields.push(("text", PayloadValue::Str(text)));
            }
            control.dispatch_event(ROOT_ID, EventKind::Clipboard, EventPayload::Map(fields));
        }
        for id in self.screen.take_image_infos() {
            let fields = vec![
                ("id", PayloadValue::Number(f64::from(id))),
                (
                    "error",
                    PayloadValue::Str("headless runs load no images".into()),
                ),
            ];
            control.dispatch_event(ROOT_ID, EventKind::ImageInfo, EventPayload::Map(fields));
        }
        // URLs are recorded (`Screen::opened_urls`) and reported opened, as
        // a device with an app for every scheme would.
        for id in self.screen.take_url_opens() {
            let fields = vec![
                ("id", PayloadValue::Number(f64::from(id))),
                ("opened", PayloadValue::Bool(true)),
            ];
            control.dispatch_event(ROOT_ID, EventKind::OpenUrl, EventPayload::Map(fields));
        }
        if self.screen.take_back_asked() {
            self.go_back(false);
        }
        self.report_finished();
    }

    fn report_finished(&mut self) {
        let finished = self.animator.take_finished();
        if !finished.is_empty() {
            self.engine.control().animations_finished(finished);
        }
    }

    /// Applies the batches that came, without waiting: the screen as it
    /// is now.
    pub fn catch_up(&mut self) {
        self.drain();
    }

    /// Applies the batches that came, without waiting.
    fn drain(&mut self) {
        while let Ok(batch) = self.batches.try_recv() {
            self.apply(&batch);
        }
        self.animator.tick();
        self.report_finished();
    }

    /// Applies the next batch, waiting until `deadline` at most, while the
    /// native animations run frame by frame; the app's errors are kept for
    /// the next check.
    fn pump(&mut self, deadline: Instant) -> Pumped {
        loop {
            if self.exited {
                return Pumped::Exited;
            }
            // On a manual clock a wanted frame comes at once; with no
            // batch from it, the caller looks again (and bounds the frames).
            let framed = self.wants_frames();
            if framed {
                self.frame(FRAME);
            }
            let wake = match self.animator.next_frame() {
                _ if framed => Instant::now(),
                Some(frame) if !self.clock.is_manual() => frame.min(deadline),
                _ => deadline,
            };
            let timeout = wake.saturating_duration_since(Instant::now());
            crossbeam_channel::select_biased! {
                recv(self.errors) -> error => {
                    if let Ok(error) = error {
                        self.seen.push(error);
                        return Pumped::Error;
                    }
                }
                recv(self.batches) -> batch => match batch {
                    Ok(batch) => {
                        self.apply(&batch);
                        return Pumped::Batch;
                    }
                    Err(_) => return Pumped::Timeout,
                },
                default(timeout) => {}
            }
            if framed {
                return Pumped::Timeout;
            }
            self.animator.tick();
            self.report_finished();
            if Instant::now() >= deadline {
                return Pumped::Timeout;
            }
        }
    }

    /// Applies the next batch, waiting `timeout` at most: the batch, or
    /// `None` when none came.
    pub fn next_batch(&mut self, timeout: Duration) -> Option<MountBatch> {
        if self.exited {
            return None;
        }
        let deadline = Instant::now() + timeout;
        let wait = deadline.saturating_duration_since(Instant::now());
        let batch = self.batches.recv_timeout(wait).ok()?;
        self.apply(&batch);
        Some(batch)
    }

    /// Applies batches until none comes for `quiet` and no native
    /// animation runs, or for `limit` at most: false if the limit ended it.
    fn quiet(&mut self, quiet: Duration, limit: Duration) -> bool {
        let end = Instant::now() + limit;
        // Frames on a manual clock come at once: the limit is its time too.
        let clock_end = self.clock.now() + limit;
        let mut last = Instant::now();
        loop {
            if self.clock.is_manual() && self.clock.now() >= clock_end {
                return false;
            }
            match self.pump((last + quiet).min(end)) {
                Pumped::Batch => last = Instant::now(),
                Pumped::Error | Pumped::Exited => return true,
                Pumped::Timeout => {
                    let now = Instant::now();
                    if !self.animator.running() && now >= last + quiet {
                        return true;
                    }
                    if now >= end {
                        return false;
                    }
                }
            }
        }
    }

    /// Applies batches until none comes for 100 ms and no native animation
    /// runs, or for 2 s at most (an app updating all the time never goes
    /// quiet): false if the limit ended it.
    pub fn settle(&mut self) -> bool {
        self.quiet(QUIET, SETTLE)
    }

    /// The step `idle`: applies batches until none comes for `quiet`, or
    /// for 10 s at most (false then). Long enough, it lets the engine's
    /// idle collection run (every second at most, after 0.3 s without
    /// work), so what the app keeps alive shows.
    pub fn idle(&mut self, quiet: Duration) -> Result<bool, String> {
        self.step("idle");
        let quiet = self.quiet(quiet, MAX_IDLE);
        self.check().map(|()| quiet)
    }

    /// Fails with the app's first error since the last check (an asset's
    /// failure is the log's only), or with what it asked that only a real
    /// platform answers.
    fn check(&mut self) -> Result<(), String> {
        while let Ok(error) = self.errors.try_recv() {
            self.seen.push(error);
        }
        for error in std::mem::take(&mut self.seen) {
            failure(error)?;
        }
        if let Some(what) = self.screen.take_unsupported().first() {
            return Err(format!(
                "the app asked for {what}, which only a real platform answers: headless runs have none"
            ));
        }
        Ok(())
    }

    /// Settles after a step, answers the dialogs it showed (unless the
    /// caller answers them), and fails if the app threw.
    fn done(&mut self) -> Result<(), String> {
        self.settle();
        self.check()?;
        loop {
            match (&mut self.dialogs, self.screen.pending_dialog()) {
                (_, None) | (Dialogs::Caller, _) => {}
                (dialogs, Some(dialog)) => {
                    let answer = match dialogs {
                        Dialogs::Handler(handler) => handler(dialog),
                        _ => default_answer(dialog)?,
                    };
                    self.answer(answer)?;
                    self.settle();
                    self.check()?;
                    continue;
                }
            }
            let files = match (&mut self.picks, self.screen.pending_pick()) {
                (_, None) | (Picks::Caller, _) => return Ok(()),
                (Picks::Default, Some(_)) => Vec::new(),
                (Picks::Handler(handler), Some((_, request))) => handler(&request),
            };
            self.pick(files)?;
            self.settle();
            self.check()?;
        }
    }

    /// Answers the oldest dialog not answered yet.
    fn answer(&mut self, answer: DialogAnswer) -> Result<(), String> {
        let dialog = self.screen.pending_dialog().ok_or("no dialog to answer")?;
        let index = match &answer {
            DialogAnswer::Press(text) => dialog
                .buttons
                .iter()
                .position(|b| b.text == *text)
                .ok_or_else(|| {
                    let buttons: Vec<&str> =
                        dialog.buttons.iter().map(|b| b.text.as_str()).collect();
                    format!(
                        "the dialog {} has no button {text:?}: {buttons:?}",
                        describe(dialog)
                    )
                })? as f64,
            DialogAnswer::Dismiss if dialog.cancelable => -1.0,
            DialogAnswer::Dismiss => {
                return Err(format!(
                    "the dialog {} cannot be dismissed: press one of its buttons",
                    describe(dialog)
                ));
            }
        };
        let id = f64::from(dialog.id);
        self.screen.answered();
        self.engine.control().dispatch_event(
            ROOT_ID,
            EventKind::Dialog,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(id)),
                ("index", PayloadValue::Number(index)),
            ]),
        );
        Ok(())
    }

    /// The step `back`: goes back as the user does (a header's back button,
    /// the back key): in the newest modal, else the whole screen, the
    /// innermost stack that can go back tells its top page (`onBackPress`,
    /// when it listens) and pops it (`onDismiss`) unless the page keeps the
    /// user (`popOnBack={false}`); without one, the newest dialog gets a
    /// close attempt (`onCancel`, reason `"cancel"`) and closes when
    /// `closeOnEscape`. Fails when there is nothing to go back from.
    pub fn back(&mut self) -> Result<(), String> {
        self.step("back");
        if !self.go_back(true) {
            return Err(format!("nothing to go back from; {}", self.on_screen()));
        }
        self.done()
    }

    /// Goes back as a platform does; false when nothing could. `ask`: the
    /// root's back listener hears it first, outside dialogs (the overlays'
    /// `onCancel`, `BackHandler`; what none takes comes back as the app's
    /// `Command::Back`, which goes back without asking).
    fn go_back(&mut self, ask: bool) -> bool {
        let control = self.engine.control();
        let target = self.screen.back_target();
        if ask
            && !matches!(target, Back::Close { .. })
            && self.screen.hears(ROOT_ID, EventKind::BackPress)
        {
            control.dispatch_event(ROOT_ID, EventKind::BackPress, EventPayload::None);
            return true;
        }
        match target {
            Back::Pop(screen) => {
                // Platforms tell a page that listens of every back press.
                if self.screen.hears(screen, EventKind::BackRequest) {
                    control.dispatch_event(screen, EventKind::BackRequest, EventPayload::None);
                }
                self.screen.pop(screen);
                control.dispatch_event(screen, EventKind::Dismiss, EventPayload::None);
            }
            Back::Ask(screen) => {
                control.dispatch_event(screen, EventKind::BackRequest, EventPayload::None);
            }
            Back::Close {
                modal,
                close_on_escape,
            } => {
                let reason =
                    EventPayload::Map(vec![("reason", PayloadValue::Str("cancel".into()))]);
                control.dispatch_event(modal, EventKind::RequestClose, reason);
                if close_on_escape {
                    self.screen.close(modal);
                    control.dispatch_event(modal, EventKind::Dismiss, EventPayload::None);
                }
            }
            Back::Nothing => return false,
        }
        true
    }

    /// The texts on screen, for errors.
    fn on_screen(&self) -> String {
        format!("on screen: {:?}", self.screen.texts())
    }

    /// The first render: waits for the app's first batch ([`WAIT`] at
    /// most), then until it is quiet.
    pub fn first_render(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + WAIT;
        while self.applied == 0 {
            match self.pump(deadline) {
                Pumped::Batch => {}
                Pumped::Error => self.check()?,
                Pumped::Exited => return self.check(),
                Pumped::Timeout => {
                    if Instant::now() >= deadline {
                        self.check()?;
                        return Err(format!("the app rendered nothing in {} s", WAIT.as_secs()));
                    }
                }
            }
        }
        self.done()
    }

    /// The step `wait(<ms>)`: applies batches for `time` (timers and
    /// animations run).
    pub fn wait(&mut self, time: Duration) -> Result<(), String> {
        self.step(format!("wait({})", time.as_millis()));
        self.elapse(time);
        self.check()
    }

    /// Applies batches until `done` holds for the screen, `timeout` at
    /// most; the error names `what` and the texts on screen.
    pub fn wait_until(
        &mut self,
        what: &str,
        timeout: Duration,
        done: impl Fn(&Screen) -> bool,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        self.drain();
        self.check()?;
        while !done(&self.screen) {
            match self.pump(deadline) {
                Pumped::Batch => {}
                Pumped::Error => self.check()?,
                Pumped::Exited => {
                    return Err(format!(
                        "{what} never happened: the app left; {}",
                        self.on_screen()
                    ));
                }
                Pumped::Timeout => {
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "{what} never happened in {} ms; {}",
                            timeout.as_millis(),
                            self.on_screen()
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// The step `waitFor(<selector>)`: applies batches until a view on
    /// screen matches `selector` ([`Screen::matches`]), for [`WAIT`] at
    /// most.
    pub fn wait_for(&mut self, selector: &str) -> Result<(), String> {
        self.wait_for_within(selector, WAIT)
    }

    /// [`Headless::wait_for`], waiting `timeout` at most.
    pub fn wait_for_within(&mut self, selector: &str, timeout: Duration) -> Result<(), String> {
        Selector::parse(selector)?;
        self.step(format!("waitFor({selector})"));
        self.wait_until(&format!("`{selector}` showing"), timeout, |s| {
            s.matches(selector) == Ok(true)
        })
    }

    /// The step `waitFor(<selector>, gone)`: applies batches until no view
    /// on screen matches `selector`, `timeout` at most.
    pub fn wait_for_gone(&mut self, selector: &str, timeout: Duration) -> Result<(), String> {
        Selector::parse(selector)?;
        self.step(format!("waitFor({selector}, gone)"));
        self.wait_until(&format!("`{selector}` gone"), timeout, |s| {
            s.matches(selector) == Ok(false)
        })
    }

    /// Applies the next batch, or runs the native animations, for `timeout`
    /// at most: what a test polling a condition waits for between looks.
    pub fn next_change(&mut self, timeout: Duration) -> Result<(), String> {
        if let Pumped::Error = self.pump(Instant::now() + timeout) {
            self.check()?;
        }
        self.check()
    }

    /// The one view `pick` gave for `selector`, or the error a step on
    /// `what` fails with.
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
                screen::disabled(what),
                self.on_screen()
            )),
        }
    }

    /// Whether a view on screen shows the text `text`.
    pub fn shows(&self, text: &str) -> bool {
        self.screen.shows(text)
    }

    /// The step `press(<selector>)`: presses what `selector` names, as a
    /// tap does ([`Screen::press_target`]: `"Save"` presses the button
    /// whose test id, label or text it is), sending the view's
    /// `onPressDown`, `onPressUp` and `onPress`, inside a finger going down
    /// and lifting on it as platforms report it to the views around it
    /// that listen to touches (an overlay's `onPressOutside` hears it).
    pub fn press(&mut self, selector: &str) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("press({selector})"));
        let pick = self.screen.pressable(&parsed);
        let id = self.picked(pick, selector, "pressable view")?;
        let at = self
            .screen
            .canvas_node(&parsed)
            .and_then(|(canvas, center)| {
                self.screen
                    .bounds_in_root(canvas)
                    .map(|b| b.origin + center)
            });
        // The finger, as platforms report it to the views around it that
        // listen to touches (an overlay's `onPressOutside` among them).
        let path = self.screen.touch_path(id);
        let contact = self
            .screen
            .begin_contact(0, id, path.clone(), !path.is_empty());
        if contact.reporting() {
            self.send_touch(&contact, nsh_core::TouchPhase::Start, path.clone(), at);
        }
        let inside = self.screen.press_point(&parsed, id);
        let payload = self.press_payload(id, inside);
        for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
            self.send(id, kind, payload.clone());
        }
        if contact.reporting() {
            self.send_touch(&contact, nsh_core::TouchPhase::End, path, at);
        }
        self.screen.end_contact(&contact);
        self.done()
    }

    /// The step `pressAt(<selector>, <x>, <y>)`: [`Headless::press`] with
    /// the pointer at `at` in the view `selector` names (its top left
    /// corner). The events tell the view where that is in it and in the
    /// root.
    pub fn press_at(&mut self, selector: &str, at: Point<Points>) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("pressAt({selector}, {}, {})", at.x.0, at.y.0));
        let pick = self.screen.pressable(&parsed);
        let id = self.picked(pick, selector, "pressable view")?;
        // `at` is in the view. The touch reports it in the root, as `press`
        // reports a canvas node's center.
        let page = self
            .screen
            .bounds_in_root(id)
            .map(|bounds| bounds.origin + at);
        let path = self.screen.touch_path(id);
        let contact = self
            .screen
            .begin_contact(0, id, path.clone(), !path.is_empty());
        if contact.reporting() {
            self.send_touch(&contact, nsh_core::TouchPhase::Start, path.clone(), page);
        }
        let payload = self.press_payload(id, Some(at));
        for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
            self.send(id, kind, payload.clone());
        }
        if contact.reporting() {
            self.send_touch(&contact, nsh_core::TouchPhase::End, path, page);
        }
        self.screen.end_contact(&contact);
        self.done()
    }

    /// A press at `at` in `view` (else the view's center), in that view
    /// and in the root, with no modifier keys. Presses on one view within
    /// [`CLICK_INTERVAL`] of each other count up (`clicks` 2 is a double
    /// press), as the platforms count them. `None` when the view has no
    /// bounds.
    fn press_payload(&mut self, view: NodeId, at: Option<Point<Points>>) -> EventPayload {
        // A pointer's press takes the keyboard focus off the pressable Tab
        // gave it to.
        if self.screen.key_focus().is_some_and(|id| id != view) {
            self.move_focus(None);
        }
        let Some(bounds) = self.screen.bounds_in_root(view) else {
            return EventPayload::None;
        };
        let now = self.clock.now();
        let clicks = match self.last_press {
            Some((last, at, clicks)) if last == view && now.duration_since(at) < CLICK_INTERVAL => {
                clicks + 1
            }
            _ => 1,
        };
        self.last_press = Some((view, now, clicks));
        let position = at.unwrap_or_else(|| {
            point(
                Points(bounds.size.width.0 / 2.0),
                Points(bounds.size.height.0 / 2.0),
            )
        });
        EventPayload::Press(PressEvent {
            position,
            page_position: point(
                Points(bounds.origin.x.0 + position.x.0),
                Points(bounds.origin.y.0 + position.y.0),
            ),
            modifiers: nsh_core::keymap::Modifiers::default(),
            clicks,
        })
    }

    /// The step `longPress(<selector>)`: holds a finger on what `selector`
    /// names (or the nearest view around it that hears long presses or
    /// presses) for its `delayLongPress` (500 ms), as a long press does:
    /// `onPressDown`, `onLongPress`, then `onPressUp`; no `onPress` follows.
    pub fn long_press(&mut self, selector: &str) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("longPress({selector})"));
        let pick = self.screen.long_pressable(&parsed);
        let id = self.picked(pick, selector, "pressable view")?;
        let delay = self.screen.long_press_delay(id).unwrap_or(500.0).max(0.0);
        let path = self.screen.touch_path(id);
        let contact = self
            .screen
            .begin_contact(0, id, path.clone(), !path.is_empty());
        if contact.reporting() {
            self.send_touch(&contact, nsh_core::TouchPhase::Start, path.clone(), None);
        }
        let payload = self.press_payload(id, None);
        self.send(id, EventKind::PressDown, payload.clone());
        self.elapse(Duration::from_secs_f64(f64::from(delay) / 1000.0));
        if contact.active() {
            self.send(id, EventKind::LongPress, payload.clone());
            self.send(id, EventKind::PressUp, payload);
            if contact.reporting() {
                self.send_touch(&contact, nsh_core::TouchPhase::End, path, None);
            }
        }
        self.screen.end_contact(&contact);
        self.done()
    }

    /// The step `clear(<selector>)`: empties the input `selector` names, as
    /// selecting all and deleting does: one `onKeyPress` of `Backspace` and
    /// an edit to nothing.
    pub fn clear(&mut self, selector: &str) -> Result<(), String> {
        let id = self.input_step(selector, format!("clear({selector})"))?;
        self.key_press(id, "Backspace");
        if let Some(input) = self.screen.input_mut(id)
            && !input.text.is_empty()
        {
            input.text.clear();
            input.count += 1;
            let payload = EventPayload::Text {
                text: String::new(),
                count: input.count,
            };
            self.engine
                .control()
                .dispatch_event(id, EventKind::ChangeText, payload);
            self.report_selection(id);
        }
        self.done()
    }

    /// The step `type(<selector>, <text>)`: types `text` at the end of the
    /// input `selector` names (the matching view, or the first input in
    /// it; `text:` also matches what an input holds or its placeholder),
    /// as a keyboard does: the input takes the focus, then each character
    /// is a key (`onKeyPress`) and an edit (`onChange`); a line break
    /// in a single-line input is the return key ([`Headless::submit`]). A
    /// character past `maxLength` is dropped.
    pub fn type_text(&mut self, selector: &str, text: &str) -> Result<(), String> {
        let id = self.input_step(selector, format!("type({selector}, {text:?})"))?;
        for c in text.chars() {
            let multiline = self.screen.input(id).is_some_and(|i| i.config.multiline);
            if c == '\n' && !multiline {
                self.return_key(id);
            } else {
                self.key(id, c);
            }
        }
        self.done()
    }

    /// The step `paste(<selector>, <content>)`: the user pastes `content`
    /// into the input `selector` names, as a paste with it on the clipboard
    /// does: the input takes the focus, `onPaste` reports it, then, while
    /// `pasteBehavior` inserts, its text is inserted at the end (a single
    /// line takes line breaks as spaces; within `maxLength`): one edit
    /// (`onChange`), no keys.
    pub fn paste(&mut self, selector: &str, content: &nsh_core::PasteEvent) -> Result<(), String> {
        let id = self.input_step(selector, format!("paste({selector})"))?;
        self.send(
            id,
            EventKind::Paste,
            EventPayload::Paste(Box::new(content.clone())),
        );
        let Some(input) = self.screen.input_mut(id) else {
            return self.done();
        };
        if input.config.paste_behavior != nsh_core::PasteBehavior::Insert || content.text.is_empty()
        {
            return self.done();
        }
        let mut text = nsh_core::text_edit::pasted(&content.text, input.config.multiline);
        if let Some(max) = input.config.max_length {
            let room = (max as usize).saturating_sub(input.text.encode_utf16().count());
            let mut used = 0;
            text = text
                .chars()
                .take_while(|c| {
                    used += c.len_utf16();
                    used <= room
                })
                .collect();
        }
        if text.is_empty() {
            return self.done();
        }
        input.text.push_str(&text);
        input.count += 1;
        let payload = EventPayload::Text {
            text: input.text.clone(),
            count: input.count,
        };
        self.engine
            .control()
            .dispatch_event(id, EventKind::ChangeText, payload);
        self.report_selection(id);
        self.done()
    }

    /// The step `submit(<selector>)`: the return key in the input
    /// `selector` names, as its `submitBehavior` says: `onSubmit`
    /// (and the focus leaves it, by default in a single line), or a line
    /// break in a multiline input.
    pub fn submit(&mut self, selector: &str) -> Result<(), String> {
        let id = self.input_step(selector, format!("submit({selector})"))?;
        self.return_key(id);
        self.done()
    }

    /// Starts a step on the input `selector` names and focuses it.
    fn input_step(&mut self, selector: &str, step: String) -> Result<NodeId, String> {
        let parsed = Selector::parse(selector)?;
        self.step(step);
        let pick = self.screen.input_view(&parsed);
        let id = self.picked(pick, selector, "input")?;
        if self.screen.input(id).is_some_and(|i| !i.config.editable) {
            return Err(format!("the input `{selector}` is not editable"));
        }
        self.move_focus(Some(id));
        Ok(id)
    }

    /// Sends `kind` to view `id` if it reports it, as platforms do.
    fn send(&self, id: NodeId, kind: EventKind, payload: EventPayload) {
        if self.screen.hears(id, kind) {
            self.engine.control().dispatch_event(id, kind, payload);
        }
    }

    /// A finger going down on (or lifting from) `target`, reported on the
    /// root with the views around it that listen to touches.
    fn send_touch(
        &self,
        contact: &Contact,
        phase: nsh_core::TouchPhase,
        path: Vec<NodeId>,
        at: Option<Point<Points>>,
    ) {
        if !contact.active() {
            return;
        }
        let target = contact.target;
        let location = at.and_then(|p| self.screen.bounds_in_root(target).map(|b| p - b.origin));
        let touch = nsh_core::TouchEvent {
            phase,
            timestamp: 0.0,
            points: vec![nsh_core::TouchPoint {
                id: contact.id,
                target,
                path,
                page: at.unwrap_or_default(),
                location: location.unwrap_or_default(),
                changed: true,
            }],
            activated: None,
        };
        self.engine.control().dispatch_event(
            ROOT_ID,
            EventKind::Touch,
            EventPayload::Touch(Box::new(touch)),
        );
    }

    fn key_press(&self, id: NodeId, key: &str) {
        self.send(
            id,
            EventKind::KeyPress,
            EventPayload::Map(vec![("key", PayloadValue::Str(key.to_owned()))]),
        );
    }

    /// The key `c` in input `id`: its text grows by it, within
    /// `maxLength`.
    fn key(&mut self, id: NodeId, c: char) {
        self.key_press(
            id,
            &if c == '\n' {
                "Enter".into()
            } else {
                c.to_string()
            },
        );
        let Some(input) = self.screen.input_mut(id) else {
            return;
        };
        let length = input.text.encode_utf16().count() + c.len_utf16();
        if input
            .config
            .max_length
            .is_some_and(|max| length > max as usize)
        {
            return;
        }
        input.text.push(c);
        input.count += 1;
        let payload = EventPayload::Text {
            text: input.text.clone(),
            count: input.count,
        };
        // Always reported: the engine keeps the text for layout and for
        // dropping stale values, whether JS listens or not.
        self.engine
            .control()
            .dispatch_event(id, EventKind::ChangeText, payload);
        self.report_selection(id);
    }

    /// `onSelectionChange` and `onCaretMove` of input `id` after an edit,
    /// as the platforms report them: the caret at the end of its text
    /// ([`Screen::input_caret`]).
    pub(crate) fn report_selection(&self, id: NodeId) {
        let Some(input) = self.screen.input(id) else {
            return;
        };
        let end = PayloadValue::Number(input.text.encode_utf16().count() as f64);
        self.send(
            id,
            EventKind::SelectionChange,
            EventPayload::Map(vec![("start", end.clone()), ("end", end)]),
        );
        let caret = self.screen.input_caret(id).unwrap_or_default();
        self.send(id, EventKind::CaretMove, EventPayload::caret(caret));
    }

    /// The return key in input `id`.
    fn return_key(&mut self, id: NodeId) {
        let Some(input) = self.screen.input(id) else {
            return;
        };
        let behavior = input.config.submit();
        let payload = EventPayload::Text {
            text: input.text.clone(),
            count: input.count,
        };
        if behavior == SubmitBehavior::Newline {
            self.key(id, '\n');
            return;
        }
        self.key_press(id, "Enter");
        self.send(id, EventKind::SubmitEditing, payload);
        if behavior == SubmitBehavior::BlurAndSubmit {
            self.screen.set_focused(None);
            self.engine
                .control()
                .set_focus_path(self.screen.focus_path());
            self.send(id, EventKind::Blur, EventPayload::None);
        }
    }

    /// One display frame of a gesture: a frame that needs nothing produces
    /// no batch, and a late one is applied with the next.
    fn display_frame(&mut self) {
        if self.clock.is_manual() {
            self.frame(FRAME);
            self.drain();
            return;
        }
        let frame = Instant::now() + FRAME;
        while Instant::now() < frame {
            if let Pumped::Batch | Pumped::Exited = self.pump(frame) {
                break;
            }
        }
    }

    /// The step `scroll(<selector>, <distance>)`: drags the scroll view
    /// `selector` names (the matching view, the nearest scroll view around
    /// it, else the first in it) by `distance` points along its axis
    /// (negative: back), 10 points per display frame, within its content.
    /// Fails if it cannot move that way at all, or the user cannot scroll it
    /// (`scrollable={false}`).
    pub fn scroll(&mut self, selector: &str, distance: Points) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("scroll({selector}, {distance})"));
        let pick = self.screen.scroll_view(&parsed);
        let id = self.picked(pick, selector, "scroll view")?;
        let at = |screen: &Screen| {
            screen
                .scroll(id)
                .map_or(Points::ZERO, |s| if s.horizontal { s.x } else { s.y })
        };
        let start = at(&self.screen);
        let target = (start + distance).clamp(Points::ZERO, self.screen.scroll_end(id));
        if (target - start).abs() < px(0.5) {
            return Err(format!(
                "`{selector}` cannot scroll by {}: it is at {} of {}",
                distance.0,
                start.0,
                self.screen.scroll_end(id).0
            ));
        }
        let offset = |screen: &Screen| {
            let s = screen.scroll(id);
            EventPayload::Scroll(s.map_or(Point::default(), |s| point(s.x, s.y)))
        };
        let contact = self.screen.begin_contact(1, id, Vec::new(), false);
        self.send(id, EventKind::ScrollDragStart, offset(&self.screen));
        // The core may shift the offset meanwhile (`ScrollBy`): each frame
        // moves on from where the view is.
        let mut frames = ((target - start).abs() / SCROLL_STEP).ceil() as usize * 2 + 10;
        while contact.active() {
            let now = at(&self.screen);
            if (target - now).abs() < px(0.5) || frames == 0 {
                break;
            }
            frames -= 1;
            let next = if target > now {
                (now + SCROLL_STEP).min(target)
            } else {
                (now - SCROLL_STEP).max(target)
            };
            let Some(scroll) = self.screen.scroll_mut(id) else {
                break;
            };
            if scroll.horizontal {
                scroll.x = next;
            } else {
                scroll.y = next;
            }
            let (x, y, applied) = (scroll.x, scroll.y, scroll.applied);
            self.engine.control().scroll(id, point(x, y), applied);
            self.animator.scrolled(id, point(x, y));
            self.display_frame();
        }
        if contact.active() {
            self.send(id, EventKind::ScrollDragEnd, offset(&self.screen));
            self.animator.scroll_ended(id);
            self.send(id, EventKind::ScrollEnd, offset(&self.screen));
        }
        self.screen.end_contact(&contact);
        self.done()
    }
}

/// How a dialog is answered when the test says nothing, as a user backing
/// out does: its cancel button, else closed when it can be; a dialog that
/// can only be answered by one of its other buttons needs the test's
/// answer ([`Headless::on_dialog`]).
pub fn default_answer(dialog: &Dialog) -> Result<DialogAnswer, String> {
    if let Some(cancel) = dialog
        .buttons
        .iter()
        .find(|b| b.style == DialogButtonStyle::Cancel)
    {
        return Ok(DialogAnswer::Press(cancel.text.clone()));
    }
    if dialog.cancelable {
        return Ok(DialogAnswer::Dismiss);
    }
    Err(format!(
        "the dialog {} needs an answer: say which button to press (`onDialog`)",
        describe(dialog)
    ))
}

/// A dialog, as errors name it: its title, else its message.
fn describe(dialog: &Dialog) -> String {
    format!(
        "{:?}",
        dialog
            .title
            .as_deref()
            .or(dialog.message.as_deref())
            .unwrap_or("")
    )
}

/// The error a step fails with for `error` of the app: none for an
/// asset's failure, which the log shows.
fn failure(error: AppError) -> Result<(), String> {
    match error.kind {
        AppErrorKind::Asset => Ok(()),
        _ => Err(format!("the app threw: {error}")),
    }
}

/// Prints `batch`, which came in step `step`, as `nsh test --trace` does: a line
/// naming the step and the number of items, then one line per item.
pub fn print_batch(out: &mut dyn Write, step: &str, batch: &MountBatch) {
    crate::trace::print_items(out, step, &crate::trace::item_lines(batch));
}

#[cfg(test)]
mod tests {
    use nsh_core::ui::{Root, prelude::*};

    use super::*;

    /// A paragraph with a link and a marked word.
    #[component]
    fn Linked() -> impl IntoElement {
        text("See ")
            .child(text("the guide").test_id("guide").underline())
            .child(" or ")
            .child(text("this").test_id("marked").bg(rgb(0xfde68a)))
    }

    #[test]
    fn span_styles_are_read_by_test_id_or_text() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Linked>())).unwrap();
        app.first_render().unwrap();
        let screen = app.screen();
        assert!(screen.span_style("id:guide").unwrap().decoration.underline);
        assert_eq!(screen.span_style("id:guide").unwrap().background, None);
        let marked = screen.span_style("id:marked").unwrap().background.unwrap();
        assert_eq!(marked.color, nsh_core::Color(0xfde6_8aff));
        assert_eq!(
            screen
                .span_style("text:this")
                .unwrap()
                .background
                .map(|b| b.color),
            Some(marked.color)
        );
    }

    #[component]
    fn EmptySpans() -> impl IntoElement {
        text("before ")
            .child(text("").test_id("middle").underline())
            .child(text("after").italic())
            .child(text("").test_id("end").underline())
            .child(text("").test_id("after"))
    }

    #[test]
    fn empty_span_styles_do_not_read_neighbouring_characters() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<EmptySpans>())).unwrap();
        app.first_render().unwrap();
        let screen = app.screen();
        for name in ["id:middle", "id:end", "middle", "end", "id:after", "after"] {
            assert!(
                screen.span_style(name).is_err(),
                "empty span {name} has no first character"
            );
        }
        assert!(screen.span_style("text:after").unwrap().italic);
    }

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

    /// A pad under a 10-point strip. A press reports where it was in the
    /// pad and in the root.
    #[component]
    fn PressPoint() -> impl IntoElement {
        let seen = signal(String::from("none"));
        view()
            .child(view().h(px(10.0)))
            .child(view().test_id("pad").w(px(80.0)).h(px(40.0)).on(
                EventKind::Press,
                move |p: &EventPayload| {
                    let EventPayload::Press(e) = p else {
                        seen.set("no position".into());
                        return;
                    };
                    seen.set(format!(
                        "at {:.0} {:.0} in {:.0} {:.0}",
                        e.position.x.0, e.position.y.0, e.page_position.x.0, e.page_position.y.0
                    ));
                },
            ))
            .child(text(move || format!("seen: {}", seen.get())))
    }

    #[test]
    fn presses_carry_where_the_pointer_was() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<PressPoint>())).unwrap();
        app.first_render().unwrap();
        app.press_at("id:pad", point(px(10.0), px(12.0))).unwrap();
        app.wait_for("seen: at 10 12 in 10 22").unwrap();
        app.press("id:pad").unwrap();
        app.wait_for("seen: at 40 20 in 40 30").unwrap();
    }

    #[test]
    fn steps_press_what_a_text_is_in_and_wait_for_what_it_shows() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Tally>())).unwrap();
        let steps = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = steps.clone();
        app.observe(move |step, _| seen.lock().unwrap().push(step.to_owned()));
        app.first_render().unwrap();
        app.wait_for("Count: 0").unwrap();
        // The text is in the pressable view: the press goes to the view.
        app.press("Add").unwrap();
        app.wait_for("text:Count: 1").unwrap();
        app.press("text:Add").unwrap();
        app.wait_for("Count: 2").unwrap();
        assert!(!app.shows("Count: 1"));
        assert_eq!(app.screen().texts(), ["Count: 2", "Add"]);
        assert_eq!(app.screen().press_target("Nothing"), Ok(None));
        assert!(app.screen().press_target("view:x").is_err());
        let error = app.press("Nothing").unwrap_err();
        assert_eq!(
            error,
            "no pressable view matches `Nothing`; on screen: [\"Count: 2\", \"Add\"]"
        );
        let error = app
            .wait_for_within("Count: 9", Duration::from_millis(50))
            .unwrap_err();
        assert!(error.starts_with("`Count: 9` showing never happened in 50 ms; on screen: "));
        let steps = steps.lock().unwrap();
        assert_eq!(steps.first().map(String::as_str), Some("open"));
        assert!(steps.iter().any(|s| s == "press(Add)"), "{steps:?}");
        assert!(steps.iter().any(|s| s == "press(text:Add)"), "{steps:?}");
    }

    /// A pad under a canvas that takes no touches and draws two cells it
    /// names as nodes. A press on a cell reaches the pad.
    #[component]
    fn Cells() -> impl IntoElement {
        let pressed = signal(0_u32);
        let touched = signal((Point::<Points>::default(), Point::<Points>::default()));
        let cell = |x: f32, label: &str, id: &str| {
            nsh_core::canvas::CanvasNode::new(
                Bounds::new(point(px(x), px(0.0)), size(px(100.0), px(40.0))),
                nsh_core::AccessibilityRole::Text,
                label,
            )
            .test_id(id)
        };
        let drawing = Painter::new()
            .fill_text("12", 4.0, 20.0)
            .fill_text("Total", 104.0, 20.0)
            .node(cell(0.0, "12", "cell-a1"))
            .node(cell(100.0, "Total", "cell-b1").selected(true));
        view()
            .child(text(move || format!("pressed: {}", pressed.get())))
            .child(text(move || {
                format!(
                    "touch x: {} local x: {}",
                    touched.get().0.x.0,
                    touched.get().1.x.0
                )
            }))
            .child(
                view()
                    .w(px(200.0))
                    .h(px(40.0))
                    .child(
                        view()
                            .test_id("pad")
                            .absolute()
                            .size_full()
                            .on_touch(move |event: &nsh_core::TouchEvent| {
                                touched.set((event.points[0].page, event.points[0].location))
                            })
                            .on_press(move || pressed.update(|n| *n += 1)),
                    )
                    .child(
                        canvas(drawing)
                            .absolute()
                            .size_full()
                            .pointer_events(PointerEvents::None),
                    ),
            )
    }

    #[test]
    fn a_canvas_nodes_are_found_and_a_press_on_one_reaches_the_view_under_it() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Cells>())).unwrap();
        app.first_render().unwrap();
        app.wait_for("id:cell-b1").unwrap();
        assert_eq!(app.screen().count("label:Total"), Ok(1));
        assert!(app.shows("12"));
        assert_eq!(app.screen().selected("id:cell-b1"), Ok(true));
        assert_eq!(app.screen().selected("id:cell-a1"), Ok(false));
        app.press("id:cell-b1").unwrap();
        app.wait_for("pressed: 1").unwrap();
        assert!(
            app.shows("touch x: 150 local x: 150"),
            "{:?}",
            app.screen().texts()
        );
        app.press("text:12").unwrap();
        app.wait_for("pressed: 2").unwrap();
        assert!(
            app.shows("touch x: 50 local x: 50"),
            "{:?}",
            app.screen().texts()
        );
    }

    /// The metrics of a line of text in a canvas font.
    #[component]
    fn Metrics() -> impl IntoElement {
        let m = text_metrics("20px system-ui", "abc");
        text(format!(
            "{} {} {} {}",
            m.width.0, m.ascent.0, m.descent.0, m.height.0
        ))
    }

    /// The approximate engine's line: characters 0.55 em wide, the line
    /// 1.2 em with its baseline at the bottom, so the ascent is the line
    /// and the descent is 0.
    #[test]
    fn text_metrics_are_the_engines_line() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Metrics>())).unwrap();
        app.first_render().unwrap();
        app.wait_for("33 24 0 24").unwrap();
    }

    #[component]
    fn FocusTransfer() -> impl IntoElement {
        let blurs = signal(0_u32);
        let presses = signal(0_u32);
        view()
            .child(
                view()
                    .test_id("button")
                    .w(px(100.0))
                    .h(px(30.0))
                    .on_press(move || presses.update(|n| *n += 1))
                    .on_blur(move || blurs.update(|n| *n += 1)),
            )
            .child(input().test_id("field"))
            .child(text(move || {
                format!("Blurs {} Presses {}", blurs.get(), presses.get())
            }))
    }

    #[test]
    fn input_steps_transfer_pressable_focus_without_reviving_it_after_submit() {
        let mut config = EngineConfig::new(Root::of::<FocusTransfer>());
        config.environment.os = nsh_core::platform::Os::MacOs;
        config.environment.idiom = nsh_core::platform::Idiom::Desktop;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        app.press_key("tab").unwrap();
        assert!(app.screen.key_focus().is_some());
        app.type_text("id:field", "Ada").unwrap();
        app.wait_for("Blurs 1 Presses 0").unwrap();
        app.submit("id:field").unwrap();
        app.press_key("enter").unwrap();
        app.press_key("space").unwrap();
        assert!(app.shows("Blurs 1 Presses 0"));
        assert_eq!(app.screen.key_focus(), None);
    }

    #[test]
    fn input_focus_commands_release_pressable_focus_before_blur() {
        let mut config = EngineConfig::new(Root::of::<FocusTransfer>());
        config.environment.os = nsh_core::platform::Os::MacOs;
        config.environment.idiom = nsh_core::platform::Idiom::Desktop;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        app.press_key("tab").unwrap();
        let field = app.screen.resolve(&Selector::parse("id:field").unwrap())[0];
        app.apply(&MountBatch {
            items: vec![MountItem::Command {
                id: field,
                command: Command::Focus,
            }],
            ..Default::default()
        });
        app.done().unwrap();
        app.wait_for("Blurs 1 Presses 0").unwrap();
        app.apply(&MountBatch {
            items: vec![MountItem::Command {
                id: field,
                command: Command::Blur,
            }],
            ..Default::default()
        });
        app.done().unwrap();
        app.press_key("enter").unwrap();
        assert!(app.shows("Blurs 1 Presses 0"));
        assert_eq!(app.screen.key_focus(), None);
    }

    #[test]
    fn replacing_a_focused_id_does_not_send_the_old_blur_to_its_replacement() {
        let mut config = EngineConfig::new(Root::of::<FocusTransfer>());
        config.environment.os = nsh_core::platform::Os::MacOs;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        app.press_key("tab").unwrap();
        let old = app.screen.key_focus().unwrap();
        let mut events = nsh_core::EventMask::default();
        events.set(EventKind::Blur, true);
        app.apply(&MountBatch {
            items: vec![
                MountItem::Delete { id: old },
                MountItem::Create {
                    id: old,
                    kind: nsh_core::ViewKind::View,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: old,
                    before: None,
                },
                MountItem::Events { id: old, events },
            ],
        });
        app.done().unwrap();
        assert!(app.shows("Blurs 0 Presses 0"));
        assert_eq!(app.screen.key_focus(), None);
    }

    /// A name field that says hello and keeps what was sent.
    #[component]
    fn Form() -> impl IntoElement {
        let name = signal(String::new());
        let sent = signal(String::new());
        let keys = signal(0_u32);
        view()
            .child(
                input()
                    .test_id("name")
                    .placeholder("Your name")
                    .max_length(5_u32)
                    .value(move || name.get())
                    .on_change(move |text: &str| name.set(text.to_owned()))
                    .on_key_press(move |_: &str| keys.update(|k| *k += 1))
                    .on_submit(move |text: &str| {
                        sent.set(text.to_owned());
                        name.set(String::new());
                    }),
            )
            .child(text(move || format!("Hello, {}", name.get())))
            .child(text(move || format!("Sent: {}", sent.get())))
            .child(text(move || format!("Keys: {}", keys.get())))
            .child(input().test_id("note").readonly(true))
    }

    #[test]
    fn typing_edits_an_input_key_by_key_and_submits_it() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Form>())).unwrap();
        app.first_render().unwrap();
        // By its placeholder, while it is empty.
        app.type_text("text:Your name", "Ada").unwrap();
        app.wait_for("Hello, Ada").unwrap();
        assert_eq!(app.screen().input_text("id:name"), Ok(Some("Ada")));
        // At the end of what it holds, cut at maxLength.
        app.type_text("id:name", " Lovelace").unwrap();
        app.wait_for("Hello, Ada L").unwrap();
        app.wait_for("Keys: 12").unwrap();
        app.submit("id:name").unwrap();
        app.wait_for("Sent: Ada L").unwrap();
        // The app cleared it: the value it set wins.
        app.wait_for("Hello, ").unwrap();
        assert_eq!(app.screen().input_text("id:name"), Ok(Some("")));
        // A line break in a single line is the return key.
        app.type_text("id:name", "Bo\n").unwrap();
        app.wait_for("Sent: Bo").unwrap();
        assert_eq!(
            app.type_text("id:note", "x").unwrap_err(),
            "the input `id:note` is not editable"
        );
        assert!(
            app.type_text("id:none", "x")
                .unwrap_err()
                .starts_with("no input matches `id:none`")
        );
    }

    /// A list of rows taller than the screen, saying where it is.
    #[component]
    fn Rows() -> impl IntoElement {
        let at = signal(0.0_f32);
        view()
            .flex_1()
            .child(text(move || format!("At {}", at.get())))
            .child(
                scroll()
                    .test_id("rows")
                    .flex_1()
                    .on_scroll(move |e: &ScrollEvent| at.set(e.offset.y.0))
                    .children((0..100).map(|i| view().h(px(50.0)).child(text(format!("Row {i}"))))),
            )
    }

    #[test]
    fn scrolling_moves_a_scroll_view_within_its_content() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Rows>())).unwrap();
        app.first_render().unwrap();
        // A row names the scroll view it is in.
        app.scroll("Row 3", px(1000.0)).unwrap();
        app.wait_for("At 1000").unwrap();
        app.scroll("id:rows", px(-400.0)).unwrap();
        app.wait_for("At 600").unwrap();
        // Not past the end: 100 rows of 50 in what the screen leaves.
        app.scroll("id:rows", px(100_000.0)).unwrap();
        let Pick::One(rows) = app
            .screen()
            .scroll_view(&Selector::parse("id:rows").unwrap())
        else {
            panic!("one list");
        };
        let end = app.screen().scroll_end(rows);
        assert!(end > px(4000.0) && end < px(5000.0), "{end}");
        app.wait_for(&format!("At {}", end.0)).unwrap();
        let error = app.scroll("id:rows", px(10.0)).unwrap_err();
        assert!(
            error.starts_with("`id:rows` cannot scroll by 10: it is at "),
            "{error}"
        );
    }

    /// A card that pans, a button, a pad listening to touches and a list
    /// that refreshes when pulled, saying what they heard.
    #[component]
    fn Drags() -> impl IntoElement {
        let pan = signal(String::from("none"));
        let presses = signal(0_u32);
        let ups = signal(0_u32);
        let touches = signal(0_u32);
        let refreshes = signal(0_u32);
        view()
            .flex_1()
            .child(text(move || format!("Pan {}", pan.get())))
            .child(text(move || {
                format!("Presses {} ups {}", presses.get(), ups.get())
            }))
            .child(text(move || format!("Touches {}", touches.get())))
            .child(text(move || format!("Refreshes {}", refreshes.get())))
            .child(
                view()
                    .test_id("card")
                    .h(px(80.0))
                    .on_pan_end(move |e: &PanEvent| {
                        pan.set(format!("{} {}", e.translation.x.0, e.translation.y.0))
                    }),
            )
            .child(
                view()
                    .test_id("button")
                    .h(px(40.0))
                    .on_press(move |_: &()| presses.update(|p| *p += 1))
                    .on_press_up(move |_: &()| ups.update(|u| *u += 1))
                    .child(text("Button")),
            )
            .child(
                view()
                    .test_id("pad")
                    .h(px(60.0))
                    .on_touch(move |_: &nsh_core::TouchEvent| touches.update(|t| *t += 1)),
            )
            .child(
                scroll()
                    .test_id("list")
                    .flex_1()
                    .on_refresh(move |_: &()| refreshes.update(|r| *r += 1))
                    .children((0..30).map(|i| view().h(px(50.0)).child(text(format!("Row {i}"))))),
            )
    }

    #[test]
    fn a_drag_goes_to_what_a_finger_would_move() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Drags>())).unwrap();
        app.first_render().unwrap();
        // A pan follows the finger to the end.
        app.drag("id:card", point(px(120.0), px(-30.0))).unwrap();
        app.wait_for("Pan 120 -30").unwrap();
        // A finger moving off a button cancels its press: up, no press.
        app.drag("Button", point(px(0.0), px(40.0))).unwrap();
        app.wait_for("Presses 0 ups 1").unwrap();
        // A small slip still presses it.
        app.drag("Button", point(px(0.0), px(4.0))).unwrap();
        app.wait_for("Presses 1 ups 2").unwrap();
        // The views listening to touches hear the finger down, moving, up.
        app.drag("id:pad", point(px(0.0), px(30.0))).unwrap();
        assert!(!app.shows("Touches 0"));
        // A list pulled down past its top refreshes; dragged up, it scrolls.
        app.drag("Row 2", point(px(0.0), px(300.0))).unwrap();
        app.wait_for("Refreshes 1").unwrap();
        let Pick::One(list) = app
            .screen()
            .scroll_view(&Selector::parse("id:list").unwrap())
        else {
            panic!("one list");
        };
        assert_eq!(app.screen().scroll(list).map(|s| s.y), Some(Points::ZERO));
        // It takes the drag over once the finger passed the slop, a frame
        // in, and follows it from there, as the platforms' scroll views do.
        app.drag("Row 2", point(px(0.0), px(-200.0))).unwrap();
        assert_eq!(app.screen().scroll(list).map(|s| s.y), Some(px(190.0)));
        // A short pull does not.
        app.drag("Row 6", point(px(0.0), px(-40.0))).unwrap();
        app.drag("Row 6", point(px(0.0), px(100.0))).unwrap();
        assert!(app.shows("Refreshes 1"));
        let error = app.drag("Nothing", point(px(1.0), px(1.0))).unwrap_err();
        assert!(error.starts_with("no view matches `Nothing`"), "{error}");
    }

    /// Keeps one real DOM node while changing its semantic owner, so the
    /// engine sends Remove and Insert of the same id in one native batch.
    #[cfg(feature = "js")]
    fn contact_app(action: &str, scrolling: bool) -> (Headless, Arc<AtomicBool>) {
        let source = r#"
import { mount, signal } from "nsh";
import { append, element, insert, prop } from "nsh:rt";
mount(() => {
  const log = signal("");
  const shown = signal(true);
  const record = value => log.set(`${log()}${value}|`);
  const root = element("view");
  prop(root, "style", { flex: 1 });
  const label = element("text");
  insert(label, () => `log ${log()}`);
  append(root, label);
  const content = element(SCROLLING ? "scroll" : "view");
  prop(content, "testID", "content");
  prop(content, "style", { height: 200 });
  prop(content, "onScrollDragEnd", () => record("scroll-end"));
  append(root, content);
  const destination = element("view");
  append(root, destination);
  const held = element("view");
  prop(held, "testID", "held");
  prop(held, "style", { height: 40 });
  prop(held, "delayLongPress", 200);
  let armed = true;
  const surgery = () => { ACTION };
  const arm = () => {
    if (armed) {
      armed = false;
      setTimeout(surgery, SCROLLING ? 160 : 10);
    }
  };
  prop(held, "onTouchStart", arm);
  prop(held, "onTouchEnd", () => record("end"));
  prop(held, "onPressDown", () => { record("down"); arm(); });
  prop(held, "onLongPress", () => record("long"));
  prop(held, "onPressUp", () => record("up"));
  prop(held, "onPress", () => record("press"));
  insert(content, () => shown() ? held : null);
  const tail = element("view");
  prop(tail, "style", { height: 1000 });
  append(content, tail);
  return root;
});
"#
        .replace("SCROLLING", if scrolling { "true" } else { "false" })
        .replace("ACTION", action);
        reinsert_app(source)
    }

    #[cfg(feature = "js")]
    fn reinsert_app(source: String) -> (Headless, Arc<AtomicBool>) {
        let mut config = EngineConfig::new(nsh_engine::Bundle::source(source));
        config.clock = Clock::manual(std::time::UNIX_EPOCH);
        let mut app = Headless::start(config).unwrap();
        let same_batch = Arc::new(AtomicBool::new(false));
        let seen = same_batch.clone();
        app.observe(move |_, batch| {
            for item in &batch.items {
                if let MountItem::Remove { id } = item
                    && batch
                        .items
                        .iter()
                        .any(|next| matches!(next,
                            MountItem::Insert { child, .. } | MountItem::ProjectRoot { id: child, .. }
                                if child == id))
                {
                    seen.store(true, Ordering::Relaxed);
                }
            }
        });
        app.first_render().unwrap();
        (app, same_batch)
    }

    #[cfg(feature = "js")]
    const REBIND_CONTACT: &str = r#"
shown.set(false);
prop(held, "onPressDown", () => record("new-down"));
prop(held, "onLongPress", () => record("new-long"));
prop(held, "onPressUp", () => record("new-up"));
prop(held, "onPress", () => record("new-press"));
prop(held, "onTouchEnd", () => record("new-end"));
shown.set(true);
record("rebound");
"#;

    #[cfg(feature = "js")]
    #[test]
    fn a_reinserted_owner_does_not_receive_the_previous_long_press_or_drag() {
        for long in [true, false] {
            let (mut app, same_batch) = contact_app(REBIND_CONTACT, false);
            let original = app.screen().press_target("id:held").unwrap();
            if long {
                app.long_press("id:held").unwrap();
            } else {
                app.drag("id:held", point(px(0.0), px(4.0))).unwrap();
            }
            assert!(same_batch.load(Ordering::Relaxed));
            assert_eq!(app.screen().press_target("id:held").unwrap(), original);
            app.wait_for("log down|rebound|").unwrap();
            // The replacement accepts a fresh physical contact normally.
            app.press("id:held").unwrap();
            app.wait_for("log down|rebound|new-down|new-up|new-press|new-end|")
                .unwrap();
        }
    }

    #[cfg(feature = "js")]
    #[test]
    fn an_insert_only_move_keeps_the_existing_long_press() {
        let (mut app, same_batch) =
            contact_app(r#"append(destination, held); record("moved");"#, false);
        app.long_press("id:held").unwrap();
        assert!(!same_batch.load(Ordering::Relaxed));
        app.wait_for("log down|moved|long|up|end|").unwrap();
    }

    #[cfg(feature = "js")]
    #[test]
    fn a_surviving_scroll_finishes_after_its_original_row_is_reinserted() {
        let (mut app, same_batch) = contact_app(REBIND_CONTACT, true);
        app.drag("id:held", point(px(0.0), px(-300.0))).unwrap();
        assert!(same_batch.load(Ordering::Relaxed));
        let Pick::One(content) = app
            .screen()
            .scroll_view(&Selector::parse("id:content").unwrap())
        else {
            panic!("one scroll view");
        };
        assert_eq!(app.screen().scroll(content).map(|s| s.y), Some(px(280.0)));
        assert!(app.screen().texts().iter().any(|text| {
            text.contains("rebound|")
                && text.contains("scroll-end|")
                && !text.contains("new-up|")
                && !text.contains("new-press|")
                && !text.contains("new-end|")
        }));
    }

    #[cfg(feature = "js")]
    #[test]
    fn a_scroll_step_stops_when_its_native_owner_is_reinserted() {
        let (mut app, reinserted) = reinsert_app(
            r#"
import { mount, signal } from "nsh";
import { append, element, insert, prop } from "nsh:rt";
mount(() => {
  const log = signal("");
  const shown = signal(true);
  const record = value => log.set(`${log()}${value}|`);
  const root = element("view");
  prop(root, "style", { flex: 1 });
  const label = element("text");
  insert(label, () => `log ${log()}`);
  append(root, label);
  const scroll = element("scroll");
  prop(scroll, "testID", "scroll");
  prop(scroll, "style", { height: 100 });
  prop(scroll, "onScroll", () => record("move"));
  prop(scroll, "onScrollDragStart", () => {
    record("start");
    setTimeout(() => {
      shown.set(false);
      prop(scroll, "onScroll", () => record("new-move"));
      prop(scroll, "onScrollDragStart", () => record("new-start"));
      prop(scroll, "onScrollDragEnd", () => record("new-drag-end"));
      prop(scroll, "onScrollEnd", () => record("new-end"));
      shown.set(true);
      record("rebound");
    }, 10);
  });
  const tail = element("view");
  prop(tail, "style", { height: 1000 });
  append(scroll, tail);
  insert(root, () => shown() ? scroll : null);
  return root;
});
"#
            .into(),
        );
        app.scroll("id:scroll", px(300.0)).unwrap();
        assert!(reinserted.load(Ordering::Relaxed));
        assert!(app.screen().texts().iter().any(|text| {
            text.contains("start|") && text.contains("rebound|") && !text.contains("new-")
        }));
        app.scroll("id:scroll", px(20.0)).unwrap();
        assert!(app.screen().texts().iter().any(|text| {
            text.contains("new-start|")
                && text.contains("new-move|")
                && text.contains("new-drag-end|")
                && text.contains("new-end|")
        }));
    }

    #[cfg(feature = "js")]
    #[test]
    fn a_reinserted_owner_does_not_inherit_the_previous_hover_path() {
        for reenter in [false, true] {
            let (mut app, reinserted) = reinsert_app(
                r#"
import { mount, signal } from "nsh";
import { append, element, insert, prop } from "nsh:rt";
mount(() => {
  const log = signal("");
  const shown = signal(true);
  const record = value => log.set(`${log()}${value}|`);
  const root = element("view");
  prop(root, "style", { flex: 1 });
  const label = element("text");
  insert(label, () => `log ${log()}`);
  append(root, label);
  const held = element("view");
  prop(held, "testID", "held");
  prop(held, "style", { height: 40 });
  prop(held, "class", "hover:opacity-50");
  prop(held, "onHoverIn", () => {
    record("in");
    setTimeout(() => {
      shown.set(false);
      prop(held, "onHoverIn", () => record("new-in"));
      prop(held, "onHoverOut", () => record("new-out"));
      shown.set(true);
      record("rebound");
    }, 10);
  });
  prop(held, "onHoverOut", () => record("out"));
  insert(root, () => shown() ? held : null);
  const other = element("view");
  prop(other, "testID", "other");
  prop(other, "style", { height: 40 });
  prop(other, "onHoverIn", () => record("other-in"));
  append(root, other);
  return root;
});
"#
                .into(),
            );
            app.set_environment("desktop pointer", |environment| {
                environment.os = nsh_core::platform::Os::MacOs;
                environment.idiom = nsh_core::platform::Idiom::Desktop;
            })
            .unwrap();
            app.hover("id:held").unwrap();
            app.run_for(Duration::from_millis(20)).unwrap();
            assert!(reinserted.load(Ordering::Relaxed));
            if reenter {
                app.hover("id:held").unwrap();
                app.wait_for("log in|rebound|new-in|").unwrap();
            } else {
                app.hover("id:other").unwrap();
                app.wait_for("log in|rebound|other-in|").unwrap();
                app.hover("id:held").unwrap();
                app.wait_for("log in|rebound|other-in|new-in|").unwrap();
            }
        }
    }

    #[cfg(feature = "js")]
    #[test]
    fn cross_parent_modal_projection_keeps_the_native_presentation_slot() {
        let source = r#"
import { mount, signal } from "nsh";
import { append, element, insert, prop } from "nsh:rt";
mount(() => {
  const picks = signal([]);
  const reopened = signal(false);
  const root = element("view");
  prop(root, "style", { flex: 1 });
  const result = element("text");
  insert(result, () => `picked ${picks().join(",")}`);
  append(root, result);
  const button = (label, onPress) => {
    const view = element("view");
    prop(view, "style", { height: 40, width: 240 });
    prop(view, "onPress", onPress);
    const text = element("text");
    insert(text, label);
    append(view, text);
    return view;
  };
  const modal = name => {
    const view = element("modal");
    prop(view, "style", { width: 320, height: 240 });
    append(view, button("Choose", () => picks.set([...picks(), name])));
    return view;
  };
  const left = element("view");
  const right = element("view");
  append(root, left);
  append(root, right);
  const older = modal("older");
  const newer = modal("newer");
  append(left, older);
  append(right, newer);
  insert(right, () => reopened() ? older : null);
  append(newer, button("Move older modal", () => append(right, older)));
  append(newer, button("Reopen older modal", () => {
    reopened.set(true);
    reopened.set(false);
    reopened.set(true);
  }));
  return root;
});
"#;
        let mut app =
            Headless::start(EngineConfig::new(nsh_engine::Bundle::source(source.into()))).unwrap();
        let projected = Arc::new(AtomicBool::new(false));
        let seen = projected.clone();
        app.observe(move |step, batch| {
            if step == "press(Move older modal)"
                && batch
                    .items
                    .iter()
                    .any(|item| matches!(item, MountItem::ProjectRoot { .. }))
            {
                seen.store(true, Ordering::Relaxed);
            }
        });
        app.first_render().unwrap();
        app.press("text:Choose >> nth=0").unwrap();
        app.wait_for("picked newer").unwrap();
        app.press("Move older modal").unwrap();
        assert!(projected.load(Ordering::Relaxed));
        app.press("text:Choose >> nth=0").unwrap();
        app.wait_for("picked newer,newer").unwrap();
        // A genuine source removal ends that slot; reopening is a new
        // presentation and now goes above the previously newer modal.
        app.press("Reopen older modal").unwrap();
        app.press("text:Choose >> nth=0").unwrap();
        app.wait_for("picked newer,newer,older").unwrap();
    }

    /// A list with a refresh indicator of its own, 100 tall.
    #[component]
    fn FarPull() -> impl IntoElement {
        let refreshes = signal(0_u32);
        view()
            .flex_1()
            .child(text(move || format!("Refreshes {}", refreshes.get())))
            .child(
                scroll()
                    .test_id("list")
                    .flex_1()
                    .refresh_indicator(Some(px(100.0)))
                    .on_refresh(move |_: &()| refreshes.update(|r| *r += 1))
                    .children((0..30).map(|i| view().h(px(50.0)).child(text(format!("Row {i}"))))),
            )
    }

    #[test]
    fn a_pull_refreshes_at_its_threshold() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<FarPull>())).unwrap();
        app.first_render().unwrap();
        // 150 points of finger rubber-band to less than 100 (past 64).
        app.drag("Row 2", point(px(0.0), px(150.0))).unwrap();
        assert!(app.shows("Refreshes 0"));
        app.drag("Row 2", point(px(0.0), px(1000.0))).unwrap();
        app.wait_for("Refreshes 1").unwrap();
    }

    /// A shortcut counting its presses, and a field.
    #[component]
    fn Shortcuts() -> impl IntoElement {
        let palette = signal(0_u32);
        let name = signal(String::new());
        on_key("mod+k", move |_| palette.update(|p| *p += 1));
        view()
            .child(text(move || format!("Palette {}", palette.get())))
            .child(
                input()
                    .test_id("name")
                    .value(move || name.get())
                    .on_change(move |text: &str| name.set(text.to_owned())),
            )
            .child(text(move || format!("Name {}", name.get())))
    }

    fn open_shortcuts(os: nsh_core::platform::Os) -> Headless {
        let mut config = EngineConfig::new(Root::of::<Shortcuts>());
        config.environment.os = os;
        config.environment.idiom = nsh_core::platform::Idiom::Desktop;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        app
    }

    #[test]
    fn a_keyboard_presses_shortcuts_and_types_into_the_focus() {
        let mut app = open_shortcuts(nsh_core::platform::Os::MacOs);
        // `mod` is Command on macOS.
        app.press_key("cmd+k").unwrap();
        app.wait_for("Palette 1").unwrap();
        app.press_key("ctrl+k").unwrap();
        assert!(app.shows("Palette 1"));
        // The focused field takes the keys it edits.
        app.type_text("id:name", "Ad").unwrap();
        app.press_key("shift+a").unwrap();
        app.press_key("backspace").unwrap();
        app.press_key("a").unwrap();
        app.wait_for("Name Ada").unwrap();
        // The shortcut fires in it too: Command+K edits no text.
        app.press_key("mod+k").unwrap();
        app.wait_for("Palette 2").unwrap();
        assert!(
            app.press_key("mod+nothing")
                .unwrap_err()
                .contains("nothing")
        );
        // Phones and tablets fire them from a hardware keyboard too; on
        // Android `mod` is Control.
        let mut phone = open_shortcuts(nsh_core::platform::Os::Ios);
        phone.press_key("cmd+k").unwrap();
        phone.wait_for("Palette 1").unwrap();
        let mut android = open_shortcuts(nsh_core::platform::Os::Android);
        android.press_key("ctrl+k").unwrap();
        android.wait_for("Palette 1").unwrap();
    }

    #[cfg(feature = "js")]
    #[test]
    fn a_step_fails_when_the_app_throws() {
        let app = nsh_engine::Bundle::source("throw new Error('boom')".into());
        let mut app = Headless::start(EngineConfig::new(app)).unwrap();
        let error = app.first_render().unwrap_err();
        assert!(error.starts_with("the app threw: Error: boom"), "{error}");
    }

    #[cfg(feature = "js")]
    #[test]
    fn process_exit_ends_a_timed_headless_wait() {
        use nsh_core::platform::Os;

        let bundle = nsh_engine::Bundle::source(
            "import process from 'process'; setTimeout(() => process.exit(0), 10);".into(),
        )
        .with_capabilities_json(Some(r#"{"process":{"exit":true}}"#))
        .unwrap();
        let mut config = EngineConfig::new(bundle);
        config.environment.os = Os::MacOs;
        let mut app = Headless::start(config).unwrap();
        let started = Instant::now();
        app.wait(Duration::from_secs(5)).unwrap();
        assert!(app.screen().sent(&Command::ExitApp));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
