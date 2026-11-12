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
//! apart, while the app asks for them or a native animation that ends by
//! itself runs (so steps finish animations without waiting for them),
//! [`Headless::wait`] and a long press move the clock by their time, and
//! [`Headless::run_for`] / [`Headless::fast_forward`] move it as a test
//! says. A step there settles as soon as the engine says it is idle
//! ([`EngineControl::flush`]), without waiting for a quiet window unless a
//! request is in flight or work keeps coming. A wait for what the app shows
//! ([`Headless::wait_until`], [`Headless::wait_for`]) moves the clock a
//! display frame at a time, looking after each frame, by its timeout at
//! most; it also waits that long in real time for work from outside the app.
//! Native animations that loop forever (a spinner) run in the background on
//! either clock: their values move with the app's time, and no step or wait
//! waits for them (nor moves a manual clock for them).
//!
//! `nsh test` runs apps this way (feature `js`: [`crate::run_file`]),
//! printing the batches under their steps with `--trace`; so do Rust tests
//! of an app's crate, which need no QuickJS for a Rust root.

mod animation;
mod audio;
mod keyboard;
#[cfg(feature = "live")]
mod live;
mod menus;
mod net;
mod pointer;
mod speech;
mod windows;

pub use audio::AudioCall;
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
    TextEngine,
    geometry::{point, px},
    platform::{InputModality, Os},
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
    failure,
    screen::{Back, Pick, Screen},
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
/// On a manual clock: how long a wait looks in real time for batches
/// between two of its frames, for what the app's clock does not bring (a
/// response a test's function gives).
const FRAME_LOOK: Duration = Duration::from_millis(1);

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
    launch(config, Vec::new(), || ApproxTextEngine, None)
        .map(|launched| (launched.engine, launched.batches))
}

/// A started engine and what it sends.
struct Launched {
    engine: Engine,
    batches: Receiver<MountBatch>,
    errors: Receiver<AppError>,
    /// On a manual clock: it asked for a frame.
    wanted: Option<Arc<AtomicBool>>,
}

/// Reports `url` as a link the system handed the app.
fn send_url_scheme(control: &nsh_engine::EngineControl, url: &str) {
    control.dispatch_event(
        ROOT_ID,
        EventKind::UrlScheme,
        EventPayload::Map(vec![(
            nsh_core::url_scheme::URL,
            PayloadValue::Str(url.to_owned()),
        )]),
    );
}

/// [`start`], the platform reporting `displays` before the app first
/// renders, laying text out with the engine `text_engine` makes; `link`:
/// the link that launched it, there before the app's code runs (as a
/// platform sends it).
fn launch<M, F>(
    mut config: EngineConfig,
    displays: Vec<nsh_core::desktop::Display>,
    text_engine: F,
    link: Option<&str>,
) -> std::io::Result<Launched>
where
    M: TextEngine + 'static,
    F: FnOnce() -> M + Send + 'static,
{
    // Only iOS and Android draw a header of their own; elsewhere a page's
    // `header` sits at its top as wide as the window, as those backends
    // configure the engine.
    if !matches!(config.environment.os, Os::Ios | Os::Android) {
        config.header_heights = nsh_core::NO_NATIVE_HEADER;
    }
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
    let engine = Engine::start_with(config, text_engine, sink, |control| {
        // Steps reach every view of a page, below its fold too.
        control.set_content_culling(false);
        if !displays.is_empty() {
            control.set_displays(displays);
        }
        if let Some(url) = link {
            send_url_scheme(control, url);
        }
    })?;
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
#[cfg(feature = "js")]
type HostPosts = Box<dyn FnMut(&str, &nsh_core::JsonValue) + Send>;

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
    Box<dyn FnMut(&nsh_core::picker::Pick) -> Vec<nsh_core::picker::PickedFile> + Send>;

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
/// it rendered nothing for 100 ms and no native animation runs that ends
/// by itself (2 s at most; on a manual clock, once the engine is idle,
/// [`Headless::settle`]), and fail when the app threw meanwhile (an exception that
/// escaped a callback, a bundle that did not load, a VM that was stopped)
/// or asked what only a real platform answers (an image from the
/// clipboard).
///
/// It plays the platform's part the NSH protocol defines and nothing
/// else: the native animation graph runs frame by frame (nsh-core's `animation`),
/// a back pops screens and closes modals, dialogs are answered (by the
/// test, else [`default_answer`]), the clipboard holds text, and `nsh
/// test`'s web page host answers `nsh/host` calls. Images are
/// not loaded: no `onLoad` comes, nor an error unless the test fails the
/// image ([`Headless::fail_images`]), and `Image.getSize` /
/// `Image.prefetch` fail.
pub struct Headless {
    engine: Engine,
    batches: Receiver<MountBatch>,
    errors: Receiver<AppError>,
    /// The app's errors seen while waiting, for the next check.
    seen: Vec<AppError>,
    /// The modifier keys held down (`keyboard.down`), which presses,
    /// drags and hovers carry.
    held: nsh_core::keymap::Modifiers,
    /// The modals presented on a desktop or the web, oldest first, each
    /// with the input or Tab stop that had the keyboard focus under it
    /// when it came, which gets it back when the modal goes
    /// ([`Headless::modals_closed`]).
    focus_before: Vec<(NodeId, Option<NodeId>)>,
    /// The finger a `dragAndHold` left down, until `drop()`.
    finger: Option<pointer::Finger>,
    screen: Screen,
    animator: Animator,
    dialogs: Dialogs,
    /// Who answers the picks.
    picks: Picks,
    /// The color the user picks on the screen ([`Headless::on_screen_color`]).
    screen_color: Option<nsh_core::Hsla>,
    /// The paths the user picks in the open dialog
    /// ([`Headless::on_pick_paths`]).
    picked_paths: Vec<std::path::PathBuf>,
    /// The path the user chooses in the save dialog
    /// ([`Headless::on_pick_save_path`]).
    save_path: Option<std::path::PathBuf>,
    /// The URLs whose images fail to load ([`Headless::fail_images`]).
    failing_images: Vec<stub::Url>,
    /// The recognizer the test speaks into; `None` when the config gave
    /// its own (`EngineConfig::speech`).
    speech: Option<speech::FakeSpeech>,
    /// The speaker the app plays to; `None` when the config gave its own
    /// (`EngineConfig::audio`).
    audio: Option<audio::FakeAudio>,
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
    #[cfg(feature = "js")]
    host_posts: Option<HostPosts>,
    /// The app's windows, on a desktop ([`windows`]); `None` elsewhere, and
    /// when the config gives its own windows (`EngineConfig::windows`).
    windows: Option<windows::Windows>,
}

impl Headless {
    /// Starts `config`'s app ([`start`]).
    pub fn start(config: EngineConfig) -> std::io::Result<Headless> {
        Self::launched_with(config, || ApproxTextEngine, None)
    }

    /// Starts `config`'s app as the link `url` launches it: the app's
    /// first `UrlScheme.url()` reads it, and its first `open` listener
    /// gets it.
    pub fn start_with_link(config: EngineConfig, url: &str) -> std::io::Result<Headless> {
        Self::launched_with(config, || ApproxTextEngine, Some(url))
    }

    /// Starts `config`'s app laying text out with the engine
    /// `text_engine` makes (on the engine's thread) instead of
    /// [`ApproxTextEngine`]: a platform's, for sizes as on screen.
    pub fn start_with_text_engine<M, F>(
        config: EngineConfig,
        text_engine: F,
    ) -> std::io::Result<Headless>
    where
        M: TextEngine + 'static,
        F: FnOnce() -> M + Send + 'static,
    {
        Self::launched_with(config, text_engine, None)
    }

    fn launched_with<M, F>(
        mut config: EngineConfig,
        text_engine: F,
        link: Option<&str>,
    ) -> std::io::Result<Headless>
    where
        M: TextEngine + 'static,
        F: FnOnce() -> M + Send + 'static,
    {
        let speech = config.speech.is_none().then(speech::FakeSpeech::default);
        if let Some(speech) = &speech {
            config.speech = Some(Arc::new(speech.clone()));
        }
        let audio = config.audio.is_none().then(audio::FakeAudio::default);
        if let Some(audio) = &audio {
            config.audio = Some(Arc::new(audio.clone()));
        }
        // A desktop's windows: the main one, focused, on one display, and
        // those the app opens. The main one starts hidden when the app's
        // nsh.json `window` says so, as a runner opens it.
        let main_hidden = config
            .app
            .main_window()
            .is_some_and(|options| !options.visible_at_launch());
        let windows = (config.environment.os.is_desktop() && config.windows.is_none()).then(|| {
            let mut windows = windows::Windows::new(config.viewport);
            if main_hidden {
                windows.start_hidden();
            }
            windows
        });
        if let Some(windows) = &windows
            && config.environment.window_state.is_none()
        {
            config.environment.window_state = Some(windows.main());
        }
        let displays = windows.as_ref().map(|w| w.displays()).unwrap_or_default();
        // The window is the viewport the app opens in, as the engine starts
        // it and as a platform reports it: a later `set_environment` sends
        // this environment whole, so it must not carry an empty window.
        config.environment.window = config.viewport;
        let environment = config.environment;
        let viewport = config.viewport;
        let clock = config.clock.clone();
        let host = config.host.clone();
        let Launched {
            engine,
            batches,
            errors,
            wanted,
        } = launch(config, displays, text_engine, link)?;
        let mut screen = Screen::default();
        screen.set_viewport(viewport);
        if main_hidden && windows.is_some() {
            screen.set_window_hidden(ROOT_ID, true);
        }
        Ok(Headless {
            engine,
            batches,
            errors,
            seen: Vec::new(),
            held: nsh_core::keymap::Modifiers::default(),
            focus_before: Vec::new(),
            finger: None,
            screen,
            animator: Animator::new(clock.clone()),
            dialogs: Dialogs::Default,
            picks: Picks::Default,
            screen_color: None,
            picked_paths: Vec::new(),
            save_path: None,
            failing_images: Vec::new(),
            speech,
            audio,
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
            #[cfg(feature = "js")]
            host_posts: None,
            windows,
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
        // A gone engine never moves the clock: the steps that wait for it
        // to move would wait for good.
        if let Err(crossbeam_channel::RecvTimeoutError::Disconnected) = rx.recv_timeout(MAX_IDLE) {
            panic!("the engine stopped (its thread panicked?): the manual clock cannot move");
        }
    }

    /// Has the engine run everything sent to it and due now, its batches
    /// sent ([`EngineControl::flush`]): whether it is idle, nothing left to
    /// run and no request in flight. False if it took until `deadline`.
    fn flush(&self, deadline: Instant) -> bool {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.engine.control().flush(move |idle| {
            let _ = tx.send(idle);
        });
        match rx.recv_deadline(deadline) {
            Ok(idle) => idle,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => false,
            // A gone engine sends nothing more.
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => true,
        }
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
    /// or a native animation that ends by itself runs (one looping forever
    /// would move the clock for as long as the driver waits).
    fn wants_frames(&self) -> bool {
        self.wanted
            .as_ref()
            .is_some_and(|w| w.load(Ordering::Relaxed))
            || (self.clock.is_manual() && self.animator.finishing())
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

    /// The step `openWithUrl(<url>)`: the system hands the app `url`, a
    /// link that opens it, as a platform reports it (`UrlScheme.on("open")`
    /// gets it when the app claims its scheme); then waits until the app
    /// is quiet.
    pub fn open_with_url(&mut self, url: &str) -> Result<(), String> {
        self.step(format!("openWithUrl({url})"));
        self.send_url_scheme(url);
        self.done()
    }

    /// The images whose source is `url` fail to load from now on, those
    /// loading now included: each image view reports the failure as a
    /// platform does (`on_error` / `onError`). `url` is matched whole and
    /// `*` in it matches anything (`"https://cdn.example.com/avatars/*"`),
    /// as [`StubNetwork`]'s routes are; an asset's is `asset:/<path>`.
    /// Other images go on loading forever, as headless runs load none.
    /// Then waits until the app is quiet.
    pub fn fail_images(&mut self, url: &str) -> Result<(), String> {
        self.step(format!("failImages({url})"));
        self.failing_images.push(stub::Url::of(url));
        self.fail_matching_images();
        self.done()
    }

    /// Fails the loads of the images [`Headless::fail_images`] named.
    fn fail_matching_images(&mut self) {
        if self.failing_images.is_empty() {
            return;
        }
        let failing = &self.failing_images;
        let failed = self
            .screen
            .fail_images(|uri| failing.iter().any(|url| url.matches(uri)));
        let control = self.engine.control();
        for (id, uri) in failed {
            let message = format!("failed to load {uri}");
            control.dispatch_event(id, EventKind::Error, EventPayload::Error { message });
        }
    }

    /// Reports `url` as a link the system handed the app, without a step:
    /// the one that launches it.
    pub fn send_url_scheme(&self, url: &str) {
        send_url_scheme(&self.engine.control(), url);
    }

    /// The step `setViewport(<w>, <h>)`: the surface becomes `size` (a
    /// rotation, a resized window), as a platform reports it.
    pub fn set_viewport(&mut self, size: Size<Points>) -> Result<(), String> {
        self.step(format!("setViewport({}, {})", size.width, size.height));
        self.viewport = size;
        self.screen.set_viewport(size);
        self.environment.window = size;
        if let Some(windows) = &mut self.windows {
            windows.resize_main(size);
            self.environment.window_state = Some(windows.main());
            windows.take_reports();
        }
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

    /// Answers the picks steps ask for (`Picker.pickImages`, `Picker.pickFiles`) with
    /// `handler`, the files the user picks, instead of cancelling them.
    pub fn on_pick(
        &mut self,
        handler: impl FnMut(&nsh_core::picker::Pick) -> Vec<nsh_core::picker::PickedFile>
        + Send
        + 'static,
    ) {
        self.picks = Picks::Handler(Box::new(handler));
    }

    /// The platform picks colors from the screen
    /// ([`nsh_core::platform::Environment::screen_color`]), and the user
    /// picks `color` whenever the app asks (`pick_screen_color`, a
    /// `ColorEyeDropper`); `None` cancels.
    pub fn on_screen_color(&mut self, color: Option<nsh_core::Hsla>) -> Result<(), String> {
        self.screen_color = color;
        self.set_environment("onScreenColor", |env| env.screen_color = true)
    }

    /// The platform has file dialogs, a file manager and a trash
    /// ([`nsh_core::platform::Environment::file_requests`]), and the user
    /// picks `paths` whenever the app shows the open dialog (`pick_paths`;
    /// none cancels). Opening, revealing and trashing paths then succeed
    /// without touching them (trashing says nowhere they went); every
    /// request is in [`Screen::file_requests`].
    pub fn on_pick_paths(&mut self, paths: Vec<std::path::PathBuf>) -> Result<(), String> {
        self.picked_paths = paths;
        self.set_environment("onPickPaths", |env| env.file_requests = true)
    }

    /// As [`Headless::on_pick_paths`], for the save dialog
    /// (`pick_save_path`): the user chooses `path`; `None` cancels.
    pub fn on_pick_save_path(&mut self, path: Option<std::path::PathBuf>) -> Result<(), String> {
        self.save_path = path;
        self.set_environment("onPickSavePath", |env| env.file_requests = true)
    }

    /// Leaves the picks steps ask for to the caller: a step returns with
    /// one asked ([`Headless::pending_pick`]) until [`Headless::answer_pick`]
    /// answers it.
    pub fn answer_picks_myself(&mut self) {
        self.picks = Picks::Caller;
    }

    /// The oldest pick asked and not answered yet.
    pub fn pending_pick(&self) -> Option<nsh_core::picker::Pick> {
        self.screen.pending_pick().map(|(_, request)| request)
    }

    /// The picks the app asked for so far, in order.
    pub fn picks(&self) -> Vec<nsh_core::picker::Pick> {
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

    /// What the app's speech recognition sessions (`Speech.start`) asked
    /// for so far, in order. Headless apps recognize speech: a session
    /// listens at once (its `start`), and the test speaks for the user
    /// ([`Headless::hear`]).
    pub fn speech_requests(&self) -> Vec<nsh_core::speech::SpeechRequest> {
        self.speech
            .as_ref()
            .map(speech::FakeSpeech::requests)
            .unwrap_or_default()
    }

    /// The user says `text` (the whole transcript so far) to the session
    /// listening, which reports it as a result that is not final; then
    /// waits until the app is quiet. Fails when no session listens.
    pub fn hear(&mut self, text: &str) -> Result<(), String> {
        self.fake_speech()?.hear(text)?;
        self.done()
    }

    /// Ends the session listening: with `error` (`no-speech`,
    /// `not-allowed`, ...), or (`None`) as when the user stops talking: the
    /// transcript as the final result, then the end (`no-speech` when
    /// nothing was heard). Then waits until the app is quiet. The app's
    /// `stop()` ends it the same way.
    pub fn end_speech(
        &mut self,
        error: Option<nsh_core::speech::SpeechError>,
    ) -> Result<(), String> {
        self.fake_speech()?.end(error)?;
        self.done()
    }

    /// What the app asked of the speaker so far (`Sound`, `AudioPlayer`),
    /// in order. Headless apps play sound: sounds decode as WAV, players
    /// play a minute of their source at once and end when the test says
    /// ([`Headless::end_audio`]).
    pub fn audio_calls(&self) -> Vec<AudioCall> {
        self.audio
            .as_ref()
            .map(audio::FakeAudio::calls)
            .unwrap_or_default()
    }

    /// The players playing reach their end (`end`; those that loop start
    /// again), then waits until the app is quiet. Fails when none plays.
    pub fn end_audio(&mut self) -> Result<(), String> {
        self.audio
            .clone()
            .ok_or_else(|| "the app plays sound with EngineConfig::audio".to_owned())?
            .end()?;
        self.done()
    }

    fn fake_speech(&self) -> Result<speech::FakeSpeech, String> {
        self.speech
            .clone()
            .ok_or_else(|| "the app recognizes speech with EngineConfig::speech".to_owned())
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

    /// Sends the app's `nsh/host` posts (the root's `Command::HostPost`) to
    /// `posts` as their batches are applied, as [`Self::on_host_call`]
    /// does calls.
    #[cfg(feature = "js")]
    pub(crate) fn on_host_post(
        &mut self,
        posts: impl FnMut(&str, &nsh_core::JsonValue) + Send + 'static,
    ) {
        self.host_posts = Some(Box::new(posts));
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

    /// Tells the engine what the step gives input with, as a platform
    /// does before acting on it: `focus-visible:` follows it.
    fn input_with(&self, modality: InputModality) {
        self.engine.control().set_input_modality(modality);
    }

    /// The batches applied so far.
    pub fn applied(&self) -> u64 {
        self.applied
    }

    fn apply(&mut self, batch: &MountBatch) {
        let focused = self.screen.focused();
        let before = focused.or(self.screen.key_focus());
        self.screen.apply(batch);
        for (id, states) in self.screen.take_restated() {
            self.engine.control().set_states(id, states);
        }
        self.focus_calls(batch, focused);
        self.modals_presented(before);
        self.modals_closed();
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
        for item in &batch.items {
            if let MountItem::Command {
                id,
                command: Command::InsertText(text),
            } = item
            {
                self.insert_text(*id, text);
            }
        }
        if let Some(windows) = &mut self.windows {
            for item in &batch.items {
                match item {
                    MountItem::Command {
                        id,
                        command: Command::Desktop(command),
                    } => windows.command(*id, command),
                    MountItem::Remove { id } | MountItem::Delete { id } => windows.removed(*id),
                    _ => {}
                }
            }
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
        #[cfg(feature = "js")]
        if let Some(posts) = &mut self.host_posts {
            for item in &batch.items {
                if let MountItem::Command {
                    id: ROOT_ID,
                    command: Command::HostPost { name, args },
                } = item
                {
                    posts(name, args);
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
        self.fail_matching_images();
        // URLs are recorded (`Screen::opened_urls`) and reported opened, as
        // a device with an app for every scheme would.
        for id in self.screen.take_url_opens() {
            let fields = vec![
                ("id", PayloadValue::Number(f64::from(id))),
                ("opened", PayloadValue::Bool(true)),
            ];
            control.dispatch_event(ROOT_ID, EventKind::OpenUrl, EventPayload::Map(fields));
        }
        for id in self.screen.take_screen_colors() {
            let mut fields = vec![("id", PayloadValue::Number(f64::from(id)))];
            if let Some(color) = self.screen_color {
                let packed = nsh_core::Color::from(color).0;
                fields.push(("color", PayloadValue::Number(f64::from(packed))));
            }
            control.dispatch_event(ROOT_ID, EventKind::ScreenColor, EventPayload::Map(fields));
        }
        for (id, request) in self.screen.take_file_answers() {
            use nsh_core::file_dialog::FileRequest;
            let paths = match request {
                FileRequest::OpenDialog(_) => self.picked_paths.clone(),
                FileRequest::SaveDialog(_) => self.save_path.clone().into_iter().collect(),
                _ => Vec::new(),
            };
            control.dispatch_event(
                ROOT_ID,
                EventKind::FileRequest,
                EventPayload::file_answer(id, paths),
            );
        }
        if self.screen.take_back_asked() {
            self.go_back(false);
        }
        self.report_windows();
        self.report_finished();
    }

    /// Reports what changed of the app's windows, as a platform does: a
    /// window of the app's own on its root, the main window in the
    /// environment; the views of a window off the screen are not found.
    fn report_windows(&mut self) {
        let Some(windows) = &mut self.windows else {
            return;
        };
        let control = self.engine.control();
        let mut environment = false;
        for report in windows.take_reports() {
            match report {
                windows::Report::Main(state) => {
                    self.environment.window_state = Some(state);
                    environment = true;
                }
                windows::Report::Window(root, event) => control.dispatch_event(
                    root,
                    EventKind::Window,
                    EventPayload::Window(Box::new(event)),
                ),
                windows::Report::Hidden(root, hidden) => {
                    self.screen.set_window_hidden(root, hidden);
                }
                windows::Report::RootSize(root, size) => {
                    control.set_root_size(root, size, Default::default());
                }
            }
        }
        if environment {
            control.set_environment(self.environment);
        }
        // `sizeToContent` on the main window: its viewport becomes that size.
        if let Some(size) = self.windows.as_mut().and_then(|w| w.take_main_resize())
            && size != self.viewport
        {
            self.viewport = size;
            self.screen.set_viewport(size);
            self.environment.window = size;
            if let Some(windows) = &mut self.windows {
                windows.resize_main(size);
                self.environment.window_state = Some(windows.main());
                windows.take_reports();
            }
            control.resize(size);
            control.set_environment(self.environment);
        }
    }

    /// A pointer acts in the window view `id` is in: the platform activates
    /// that window first (the one that had the focus loses it).
    fn activate_window_of(&mut self, id: NodeId) {
        let window = self.screen.window_of(id);
        if let Some(windows) = &mut self.windows {
            windows.pressed_in(window);
        }
        self.report_windows();
    }

    /// The state of the app's window `id` (`"main"`, or the id it opened
    /// one with) as the platform reports it; `None` while it is not open
    /// (`app.window(id).state()`).
    pub fn window_state(
        &mut self,
        id: &str,
    ) -> Result<Option<nsh_core::desktop::WindowState>, String> {
        self.catch_up();
        let windows = self.windows.as_ref().ok_or_else(no_windows)?;
        Ok(self
            .screen
            .window_root(id)
            .and_then(|root| windows.state(root)))
    }

    /// The step `window(<id>).pressClose()`: the user presses the close
    /// button of the app's window `id`: the window reports the press
    /// (`onClosePress`, reason `closeButton`) and closes when its
    /// `closeOnPress` lets it; then waits until the app is quiet.
    pub fn press_window_close(&mut self, id: &str) -> Result<(), String> {
        self.step(format!("window({id}).pressClose"));
        self.catch_up();
        let root = self
            .screen
            .window_root(id)
            .ok_or_else(|| format!("no window {id:?} is open"))?;
        let windows = self.windows.as_mut().ok_or_else(no_windows)?;
        windows
            .press_close(root)
            .map_err(|e| format!("cannot press the close button of window {id:?}: {e}"))?;
        self.report_windows();
        self.done()
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
    /// animation that ends by itself runs, or for `limit` at most: false if
    /// the limit ended it.
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
                    if !self.animator.finishing() && now >= last + quiet {
                        return true;
                    }
                    if now >= end {
                        return false;
                    }
                }
            }
        }
    }

    /// On a manual clock: applies batches until the app is idle, or for
    /// `limit` at most (of real time, and of the clock's while frames move
    /// it): false if the limit ended it. Idle is asked, not waited for:
    /// the engine ran everything sent to it and due now, its batches came
    /// and were applied, it wants no frame and no native animation that
    /// ends by itself runs. While a request is in flight (its answer comes
    /// from elsewhere) or work keeps coming, it waits for the batches to
    /// stop for [`QUIET`], as on the system's clock.
    fn idle_on_manual_clock(&mut self, limit: Duration) -> bool {
        let end = Instant::now() + limit;
        let clock_end = self.clock.now() + limit;
        loop {
            if self.exited || !self.errors.is_empty() {
                return true;
            }
            if self.clock.now() >= clock_end || Instant::now() >= end {
                return false;
            }
            if self.wants_frames() {
                self.frame(FRAME);
                self.drain();
                continue;
            }
            let applied = self.applied;
            let idle = self.flush(end);
            self.drain();
            if self.applied != applied || self.wants_frames() || !self.errors.is_empty() {
                continue;
            }
            if idle {
                return true;
            }
            // What comes from elsewhere comes in real time.
            match self.pump((Instant::now() + QUIET).min(end)) {
                Pumped::Batch => {}
                Pumped::Error | Pumped::Exited => return true,
                // Nothing came for `QUIET` (no frame was wanted).
                Pumped::Timeout => return Instant::now() < end,
            }
        }
    }

    /// Applies batches until the app is done with a step, or for 2 s at
    /// most (an app updating all the time never is): false if the limit
    /// ended it. On the system's clock it is done when no batch came for
    /// 100 ms and no native animation that ends by itself runs; on a
    /// manual clock, as soon as the engine says it is idle
    /// ([`EngineControl::flush`]), without waiting.
    pub fn settle(&mut self) -> bool {
        if self.clock.is_manual() {
            self.idle_on_manual_clock(SETTLE)
        } else {
            self.quiet(QUIET, SETTLE)
        }
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
            return Err(format!(
                "{}; {}",
                failure::NOTHING_TO_GO_BACK_FROM,
                self.on_screen()
            ));
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
                    self.modals_closed();
                    control.dispatch_event(modal, EventKind::Dismiss, EventPayload::None);
                }
            }
            Back::Nothing => return false,
        }
        true
    }

    /// The texts on screen, for errors: cut to
    /// [`SCREEN_TEXT_LIMIT`](crate::failure::SCREEN_TEXT_LIMIT) so a long
    /// document cannot flood the error.
    fn on_screen(&self) -> String {
        let texts = self.screen.texts();
        format!(
            "on screen: [{}]",
            crate::failure::screen_texts(&texts, Some(crate::failure::SCREEN_TEXT_LIMIT))
        )
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
                        return Err(failure::rendered_nothing(WAIT));
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
    /// most; the error names `what` and the texts on screen. On a manual
    /// clock the wait moves it, a display frame at a time (the timers due
    /// run on the way, as [`Headless::run_for`] runs them), looking after
    /// each frame, by `timeout` at most; it fails once the clock moved that
    /// far and `timeout` of real time passed too, so what comes from
    /// outside the app (a route's function, the network) has that long.
    pub fn wait_until(
        &mut self,
        what: &str,
        timeout: Duration,
        done: impl Fn(&Screen) -> bool,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let clock_end = self.clock.is_manual().then(|| self.clock.now() + timeout);
        self.drain();
        self.check()?;
        while !done(&self.screen) {
            // The clock moves by the timeout at most; then the wait goes on
            // for what comes from outside the app, until as much real time
            // passed.
            let pumped = match clock_end {
                Some(end) if self.clock.now() < end => {
                    let left = end.saturating_duration_since(self.clock.now());
                    self.wait_frame(left.min(FRAME))
                }
                _ => self.pump(deadline),
            };
            match pumped {
                Pumped::Batch => {}
                Pumped::Error => self.check()?,
                Pumped::Exited => {
                    return Err(format!(
                        "{what} never happened: the app left; {}",
                        self.on_screen()
                    ));
                }
                Pumped::Timeout => {
                    let over = Instant::now() >= deadline
                        && clock_end.is_none_or(|end| self.clock.now() >= end);
                    if over {
                        return Err(format!(
                            "{}; {}",
                            failure::never_happened(what, timeout),
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

    /// What a test polling a condition waits for between looks, as
    /// [`Headless::wait_until`] waits: on a manual clock, moves it by a
    /// display frame (`timeout` of the app's time at most) and applies what
    /// came, giving how far the clock moved; on the system's clock,
    /// [`Headless::next_change`] (and zero).
    pub fn next_frame(&mut self, timeout: Duration) -> Result<Duration, String> {
        if !self.clock.is_manual() {
            return self.next_change(timeout).map(|()| Duration::ZERO);
        }
        // An app that left takes no frame, but the wait's time runs out.
        let by = timeout.min(FRAME);
        if !by.is_zero() {
            self.wait_frame(by);
        }
        self.check().map(|()| by)
    }

    /// On a manual clock: a frame of a wait, `by` after the last, and what
    /// it brought; then a batch or an error that comes within
    /// [`FRAME_LOOK`] of real time.
    fn wait_frame(&mut self, by: Duration) -> Pumped {
        if self.exited {
            return Pumped::Exited;
        }
        self.frame(by);
        self.drain();
        crossbeam_channel::select_biased! {
            recv(self.errors) -> error => match error {
                Ok(error) => {
                    self.seen.push(error);
                    Pumped::Error
                }
                Err(_) => Pumped::Timeout,
            },
            recv(self.batches) -> batch => match batch {
                Ok(batch) => {
                    self.apply(&batch);
                    Pumped::Batch
                }
                Err(_) => Pumped::Timeout,
            },
            default(FRAME_LOOK) => Pumped::Timeout,
        }
    }

    /// The one view `pick` gave for `selector`, or the error a step on
    /// `what` fails with.
    fn picked(&self, pick: Pick, selector: &str, what: &str) -> Result<NodeId, String> {
        match pick {
            Pick::One(id) => Ok(id),
            Pick::None => Err(format!(
                "{}; {}",
                failure::not_found(what, selector),
                self.on_screen()
            )),
            Pick::Many(n) => Err(format!(
                "`{selector}` matches {n} {what}s: say which (`{selector} >> nth=0`), or look inside \
                 a view around it (`id:list >> {selector}`)"
            )),
            Pick::Disabled => Err(format!(
                "{}; {}",
                failure::disabled(selector, what),
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
    /// that listen to touches (an overlay's `onPressOutside` hears it). A
    /// text field that listens to presses takes the focus first, as a tap
    /// in it does.
    pub fn press(&mut self, selector: &str) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("press({selector})"));
        self.input_with(InputModality::Pointer);
        let pick = self.screen.pressable(&parsed);
        let mut id = self.picked(pick, selector, "pressable view")?;
        let mut routed = None;
        // A real finger lands where the view is drawn: a view drawn over it
        // there takes the press, so the step fails as the user would. The
        // finger goes on the part of the view that is visible — a view
        // across a scroll view's fold is pressed on the half left visible,
        // its laid-out center lying below the fold, on the bar under it; a
        // view nothing of which is on screen (a target scrolled out of
        // view) keeps its laid-out center, which a press still reaches as
        // before. A view that takes no pointer (in a `pointerEvents: none`
        // subtree, as a data table's cells under its hit layer) is pressed
        // where it is, by the view a pointer there reaches.
        if let Some(target) = self.screen.bounds_in_root(id) {
            let point = self
                .screen
                .press_point(&parsed, id)
                .map_or(target.center(), |p| target.origin + p);
            let point = match self.screen.visible_bounds_in_root(id) {
                Some(visible) if visible.contains(&point) => point,
                Some(visible) => visible.center(),
                None => point,
            };
            if let Some((to, inside)) = self.screen.routed_press(id, point) {
                (id, routed) = (to, Some(inside));
            } else if let Some(cover) = self.screen.covering(id, point) {
                return Err(format!(
                    "{}; {}",
                    failure::covered(selector, &self.screen.selector_of(cover)),
                    self.on_screen()
                ));
            }
        }
        let at = self
            .screen
            .canvas_node(&parsed)
            .and_then(|(canvas, center)| {
                self.screen
                    .bounds_in_root(canvas)
                    .map(|b| b.origin + center)
            });
        self.activate_window_of(id);
        // The finger, as platforms report it to the views around it that
        // listen to touches (an overlay's `onPressOutside` among them).
        let path = self.screen.touch_path(id);
        if !path.is_empty() {
            self.send_touch(id, nsh_core::TouchPhase::Start, path.clone(), at);
        }
        // A text field that listens to presses (a combobox's) takes the
        // focus as a tap's does, then hears the press.
        if self.screen.input(id).is_some_and(|i| i.config.editable)
            && self.screen.focused() != Some(id)
        {
            self.move_focus(Some(id));
        }
        let inside = routed.or_else(|| self.screen.press_point(&parsed, id));
        let payload = self.press_payload(id, inside);
        for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
            self.send(id, kind, payload.clone());
        }
        if !path.is_empty() {
            self.send_touch(id, nsh_core::TouchPhase::End, path, at);
        }
        self.done()
    }

    /// The step `pressAt(<selector>, <x>, <y>)`: [`Headless::press`] with
    /// the pointer at `at` in the view `selector` names (its top left
    /// corner). The events tell the view where that is in it and in the
    /// root.
    pub fn press_at(&mut self, selector: &str, at: Point<Points>) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("pressAt({selector}, {}, {})", at.x.0, at.y.0));
        self.input_with(InputModality::Pointer);
        let pick = self.screen.pressable(&parsed);
        let id = self.picked(pick, selector, "pressable view")?;
        // `at` is in the view the selector names, which may be inside the
        // pressable the press goes to (a paragraph's text in an editor):
        // it is moved into that view's coordinates. The touch reports it
        // in the root, as `press` reports a canvas node's center.
        let named = match self.screen.resolve(&parsed)[..] {
            [named] => named,
            _ => id,
        };
        let page = self
            .screen
            .bounds_in_root(named)
            .map(|bounds| bounds.origin + at);
        let at = match (page, self.screen.bounds_in_root(id)) {
            (Some(page), Some(target)) => page - target.origin,
            _ => at,
        };
        self.activate_window_of(id);
        let path = self.screen.touch_path(id);
        if !path.is_empty() {
            self.send_touch(id, nsh_core::TouchPhase::Start, path.clone(), page);
        }
        let payload = self.press_payload(id, Some(at));
        for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
            self.send(id, kind, payload.clone());
        }
        if !path.is_empty() {
            self.send_touch(id, nsh_core::TouchPhase::End, path, page);
        }
        self.done()
    }

    /// A press at `at` in `view` (else the view's center), in that view
    /// and in the root, with the modifier keys held (`keyboard.down`). Presses on one view within
    /// [`CLICK_INTERVAL`] of each other count up (`clicks` 2 is a double
    /// press), as the platforms count them. `None` when the view has no
    /// bounds.
    fn press_payload(&mut self, view: NodeId, at: Option<Point<Points>>) -> EventPayload {
        // In a terminal a press gives the stop it is on (or in) the
        // focus, as terminal apps do, and Tab goes on from there.
        let stop = (self.environment.idiom == nsh_core::platform::Idiom::Terminal)
            .then(|| self.screen.stop_around(view))
            .flatten();
        if let Some(stop) = stop {
            self.move_focus(Some(stop));
        } else if self.screen.key_focus().is_some_and(|id| id != view) {
            // A pointer's press takes the keyboard focus off the view Tab
            // gave it to.
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
            modifiers: self.held,
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
        self.input_with(InputModality::Pointer);
        let pick = self.screen.long_pressable(&parsed);
        let id = self.picked(pick, selector, "pressable view")?;
        let delay = self.screen.long_press_delay(id).unwrap_or(500.0).max(0.0);
        self.activate_window_of(id);
        let path = self.screen.touch_path(id);
        if !path.is_empty() {
            self.send_touch(id, nsh_core::TouchPhase::Start, path.clone(), None);
        }
        let inside = self.screen.press_point(&parsed, id);
        let payload = self.press_payload(id, inside);
        self.send(id, EventKind::PressDown, payload.clone());
        self.elapse(Duration::from_secs_f64(f64::from(delay) / 1000.0));
        self.send(id, EventKind::LongPress, payload.clone());
        self.send(id, EventKind::PressUp, payload);
        if !path.is_empty() {
            self.send_touch(id, nsh_core::TouchPhase::End, path, None);
        }
        self.done()
    }

    /// The step `clear(<selector>)`: empties the input `selector` names, as
    /// selecting all and deleting does: one `onKeyPress` of `Backspace` and
    /// an edit to nothing.
    pub fn clear(&mut self, selector: &str) -> Result<(), String> {
        let id = self.input_step(selector, format!("clear({selector})"))?;
        self.input_with(InputModality::Keyboard);
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
        self.input_with(InputModality::Keyboard);
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
        self.paste_into(id, content);
        self.done()
    }

    /// The user's paste of `content` into input `id`: it hears `onPaste`,
    /// then its text goes in as `pasteBehavior` says.
    pub(crate) fn paste_into(&mut self, id: NodeId, content: &nsh_core::PasteEvent) {
        self.send(
            id,
            EventKind::Paste,
            EventPayload::Paste(Box::new(content.clone())),
        );
        let Some(input) = self.screen.input_mut(id) else {
            return;
        };
        if input.config.paste_behavior != nsh_core::PasteBehavior::Insert || content.text.is_empty()
        {
            return;
        }
        self.insert_text(id, &content.text);
    }

    /// `text` goes into input `id` as the user's edit (a paste, the app's
    /// `insertText`): at the end, where the caret is here (a single line
    /// takes line breaks as spaces; within `maxLength`), one `onChange`,
    /// no keys.
    pub(crate) fn insert_text(&mut self, id: NodeId, text: &str) {
        let Some(input) = self.screen.input_mut(id) else {
            return;
        };
        if !input.config.editable {
            return;
        }
        let mut text = nsh_core::text_edit::pasted(text, input.config.multiline);
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
            return;
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
    }

    /// The step `submit(<selector>)`: the return key in the input
    /// `selector` names, as its `submitBehavior` says: `onSubmit`
    /// (and the focus leaves it, by default in a single line), or a line
    /// break in a multiline input.
    pub fn submit(&mut self, selector: &str) -> Result<(), String> {
        let id = self.input_step(selector, format!("submit({selector})"))?;
        self.input_with(InputModality::Keyboard);
        self.return_key(id);
        self.done()
    }

    /// Starts a step on the input `selector` names and focuses it; what an
    /// input method composes in it ends, as a key or a paste commits it.
    fn input_step(&mut self, selector: &str, step: String) -> Result<NodeId, String> {
        let id = self.focus_step(selector, step)?;
        self.set_composition(id, None);
        Ok(id)
    }

    /// The step `compose(<selector>, <text>)`: an input method composes
    /// `text` in the input `selector` names, marked at the end of its
    /// text in place of what it composed (`onCompositionChange`), as a
    /// user typing pinyin sees it; empty, the composition ends with
    /// nothing committed. The core measures the input with it.
    pub fn compose(&mut self, selector: &str, text: &str) -> Result<(), String> {
        let id = self.focus_step(selector, format!("compose({selector}, {text:?})"))?;
        self.set_composition(id, (!text.is_empty()).then(|| text.to_owned()));
        self.done()
    }

    /// Input `id`'s composition becomes `marked` (`None`: it ends),
    /// reported to the core and as `onCompositionChange` if it changed.
    fn set_composition(&mut self, id: NodeId, marked: Option<String>) {
        let Some(input) = self.screen.input_mut(id) else {
            return;
        };
        if input.composition == marked {
            return;
        }
        let shown = marked.as_ref().map(|m| format!("{}{m}", input.text));
        let payload = EventPayload::Map(vec![
            ("composing", PayloadValue::Bool(marked.is_some())),
            (
                "text",
                PayloadValue::Str(marked.clone().unwrap_or_default()),
            ),
        ]);
        input.composition = marked;
        self.engine.control().input_composing(id, shown);
        self.send(id, EventKind::CompositionChange, payload);
    }

    /// Starts a step on the input `selector` names and focuses it.
    fn focus_step(&mut self, selector: &str, step: String) -> Result<NodeId, String> {
        let parsed = Selector::parse(selector)?;
        self.step(step);
        let pick = self.screen.input_view(&parsed);
        let id = self.picked(pick, selector, "input")?;
        if self.screen.input(id).is_some_and(|i| !i.config.editable) {
            return Err(format!("the input `{selector}` is not editable"));
        }
        if self.screen.focused() != Some(id) {
            if let Some(old) = self.screen.focused() {
                self.set_focused_state(old, false);
                self.send(old, EventKind::Blur, EventPayload::None);
            }
            self.screen.set_focused(Some(id));
            self.set_focused_state(id, true);
            self.send(id, EventKind::Focus, EventPayload::None);
        }
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
        target: NodeId,
        phase: nsh_core::TouchPhase,
        path: Vec<NodeId>,
        at: Option<Point<Points>>,
    ) {
        let location = at.and_then(|p| self.screen.bounds_in_root(target).map(|b| p - b.origin));
        let touch = nsh_core::TouchEvent {
            phase,
            timestamp: 0.0,
            points: vec![nsh_core::TouchPoint {
                id: 0,
                target,
                path,
                page: at.unwrap_or_default(),
                location: location.unwrap_or_default(),
                changed: true,
                pointer_type: nsh_core::PointerType::Touch,
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
            self.set_focused_state(id, false);
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
        self.input_with(InputModality::Pointer);
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
        self.send(id, EventKind::ScrollDragStart, offset(&self.screen));
        // The core may shift the offset meanwhile (`ScrollBy`): each frame
        // moves on from where the view is.
        let mut frames = ((target - start).abs() / SCROLL_STEP).ceil() as usize * 2 + 10;
        loop {
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
        self.send(id, EventKind::ScrollDragEnd, offset(&self.screen));
        self.animator.scroll_ended(id);
        self.send(id, EventKind::ScrollEnd, offset(&self.screen));
        self.done()
    }
}

/// Why a step on windows fails off the desktops.
fn no_windows() -> String {
    "the app has no windows of its own here: open it as a desktop app (`platform: \"macos\"`, \"windows\" or \"linux\")".into()
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
    use nsh_core::{
        element::{Root, input},
        prelude::*,
    };

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

    /// A paragraph whose last words hold their place hidden.
    #[component]
    fn Partly() -> impl IntoElement {
        text("Shown ")
            .child(text("not yet").invisible())
            .child(" end")
    }

    #[test]
    fn hidden_spans_are_not_on_screen() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Partly>())).unwrap();
        app.first_render().unwrap();
        let screen = app.screen();
        assert_eq!(screen.texts(), ["Shown  end"]);
        assert!(!screen.shows("not yet"));
        let nodes = screen.layout_nodes();
        let text = nodes.iter().find_map(|n| n.text.as_ref()).unwrap();
        // The characters are still laid out, in the text the platform gets.
        assert_eq!(text.text.text, "Shown not yet end");
        assert!(text.text.spans[1].style.hidden);
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
        app.wait_for("text:seen: at 10 12 in 10 22").unwrap();
        app.press("id:pad").unwrap();
        app.wait_for("text:seen: at 40 20 in 40 30").unwrap();
    }

    #[component]
    fn RetainedLayout() -> impl IntoElement {
        let count = signal(0_u32);
        let listener: nsh_core::element::Listener<Bounds<Points>> =
            (move |_: &Bounds<Points>| count.update(|n| *n += 1)).into();
        view().child(dynamic(move || {
            let current = count.get();
            let width = signal(0.0_f32);
            view()
                .w(px(100.0))
                .h(px(40.0))
                .on_layout(listener.clone())
                .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
                .child(text(move || {
                    format!("count {current} width {}", width.get())
                }))
        }))
    }

    #[test]
    fn retained_layout_listeners_settle_while_new_runs_learn_the_frame() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<RetainedLayout>())).unwrap();
        app.first_render().unwrap();
        app.wait_for("count 1 width 100").unwrap();
        assert!(!app.shows("count 2 width 100"));
    }

    /// A box whose layout flips a region in it, whose node keeps its width
    /// in a signal of the region's run (#448).
    #[component]
    fn GrowingBox() -> impl IntoElement {
        let width = signal(100.0_f32);
        let wide = signal(false);
        view()
            .child(
                view()
                    .on_press(move || width.update(|w| *w += 100.0))
                    .child(text("Grow")),
            )
            .child(
                view()
                    .w(move || px(width.get()))
                    .h(px(40.0))
                    .on_layout(move |b: &Bounds<Points>| wide.set(b.size.width.0 > 150.0))
                    .child(dynamic(move || {
                        let is_wide = wide.get();
                        let size = signal(0.0_f32);
                        view()
                            .w_full()
                            .h(px(20.0))
                            .on_layout(move |b: &Bounds<Points>| size.set(b.size.width.0))
                            .child(text(move || format!("wide {is_wide} inner {}", size.get())))
                    })),
            )
    }

    #[test]
    fn a_region_run_replaced_in_a_layout_pass_misses_its_nodes_layout() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<GrowingBox>())).unwrap();
        app.first_render().unwrap();
        app.wait_for("wide false inner 100").unwrap();
        // The box's layout flips the region before the old node's, from the
        // same pass, is handed out: its listener, whose `size` went with its
        // run, no longer runs, and the new run's learns the width.
        app.press("Grow").unwrap();
        app.wait_for("wide true inner 200").unwrap();
    }

    /// A page whose `header` holds a back button, a one-line title far
    /// wider than the window and a button after it.
    #[component]
    fn LongTitle() -> impl IntoElement {
        let button = |id: &'static str| view().test_id(id).size(px(44.0)).flex_shrink_0();
        nsh_core::element::stack().flex_1().child(
            nsh_core::element::screen()
                .header(
                    view()
                        .test_id("bar")
                        .flex_row()
                        .child(button("back"))
                        .child(
                            view().test_id("title").flex_1().min_w(px(0.0)).child(
                                text("A title far too long for one line of the header ".repeat(4))
                                    .number_of_lines(1),
                            ),
                        )
                        .child(button("action")),
                )
                .child(view().flex_1()),
        )
    }

    /// On a desktop, as its backends run it, a page's `header` is placed
    /// by NSH as wide as the window: a long title shrinks and the button
    /// after it stays in the window, whatever the window's width.
    #[test]
    fn a_desktop_page_header_is_as_wide_as_the_window() {
        let mut config = EngineConfig::new(Root::of::<LongTitle>());
        config.viewport = Size::new(px(360.0), px(600.0));
        config.environment.os = Os::MacOs;
        config.environment.idiom = nsh_core::platform::Idiom::Desktop;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        for width in [360.0, 600.0] {
            app.set_viewport(Size::new(px(width), px(600.0))).unwrap();
            let nodes = app.screen().layout_nodes();
            let bounds = |id: &str| {
                nodes
                    .iter()
                    .find(|n| n.test_id.as_deref() == Some(id))
                    .unwrap_or_else(|| panic!("no {id}"))
                    .bounds
            };
            let header = nodes
                .iter()
                .find(|n| n.kind == nsh_core::ViewKind::HeaderItem)
                .expect("the header")
                .bounds;
            assert_eq!(header.size.width, px(width), "the header at {width}");
            assert_eq!(bounds("bar").size.width, px(width), "its row at {width}");
            let action = bounds("action");
            assert_eq!(
                action.origin.x + action.size.width,
                px(width),
                "the button after the title at {width}"
            );
            assert_eq!(bounds("title").size.width, px(width - 88.0));
        }
    }

    /// A press whose task finishes a turn later, with no time passing.
    #[component]
    fn Deferred() -> impl IntoElement {
        let presses = signal(0_u32);
        let done = signal(0_u32);
        view()
            .child(text(move || format!("Done: {}", done.get())))
            .child(
                view()
                    .on_press(move || presses.update(|p| *p += 1))
                    .child(text("Go")),
            )
            .child(dynamic(move || {
                let pressed = presses.get();
                spawn(async move {
                    timer(Duration::ZERO).await;
                    done.set(pressed);
                });
                view()
            }))
    }

    #[test]
    fn on_a_manual_clock_a_step_returns_once_the_app_is_idle() {
        const STEPS: u32 = 20;
        let mut config = EngineConfig::new(Root::of::<Deferred>());
        config.clock = Clock::manual(std::time::SystemTime::UNIX_EPOCH);
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        assert!(app.shows("Done: 0"));
        let started = Instant::now();
        for step in 1..=STEPS {
            app.press("Go").unwrap();
            // The task the press started ran before the step returned.
            assert!(
                app.shows(&format!("Done: {step}")),
                "{:?}",
                app.screen().texts()
            );
        }
        // No step waited for a quiet window: with one each, the steps take
        // `QUIET` each at least.
        let took = started.elapsed();
        assert!(took < QUIET * STEPS, "{took:?}");
    }

    /// An avatar that falls back to initials when its picture fails, and a
    /// logo whose `src` a press changes.
    #[component]
    fn Pictures() -> impl IntoElement {
        let avatar_failed = signal(String::new());
        let logo = signal("asset:/logo.png");
        let logo_failed = signal(false);
        view()
            .child(
                image("https://cdn.test/ada.png")
                    .on_error(move |message: &str| avatar_failed.set(message.to_owned())),
            )
            .child(text(move || {
                let message = avatar_failed.get();
                if message.is_empty() {
                    "avatar: picture".to_owned()
                } else {
                    format!("avatar: AL ({message})")
                }
            }))
            .child(image(move || logo.get()).on_error(move |_: &str| logo_failed.set(true)))
            .child(text(move || format!("logo failed: {}", logo_failed.get())))
            .child(
                view()
                    .on_press(move || logo.set("https://cdn.test/logos/b.png"))
                    .child(text("Switch")),
            )
    }

    #[test]
    fn a_test_fails_the_loads_of_the_images_it_names() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Pictures>())).unwrap();
        app.first_render().unwrap();
        app.wait(Duration::from_millis(50)).unwrap();
        assert!(app.shows("avatar: picture"), "no failure unasked");

        // An image already shown fails when the test names it.
        app.fail_images("https://cdn.test/ada.png").unwrap();
        app.wait_for("text:avatar: AL (failed to load https://cdn.test/ada.png)")
            .unwrap();
        assert!(app.shows("logo failed: false"), "only the URL named");

        // One loaded later fails as it starts loading.
        app.fail_images("https://cdn.test/logos/*").unwrap();
        assert!(app.shows("logo failed: false"));
        app.press("Switch").unwrap();
        app.wait_for("text:logo failed: true").unwrap();
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
        app.wait_for("text:pressed: 1").unwrap();
        assert!(
            app.shows("touch x: 150 local x: 150"),
            "{:?}",
            app.screen().texts()
        );
        app.press("text:12").unwrap();
        app.wait_for("text:pressed: 2").unwrap();
        assert!(
            app.shows("touch x: 50 local x: 50"),
            "{:?}",
            app.screen().texts()
        );
    }

    /// A toolbar's group of a toggle button, a heading with its level and
    /// a pagination's current page.
    #[component]
    fn Formatting() -> impl IntoElement {
        let bold = signal(false);
        view()
            .child(
                view()
                    .role(AccessibilityRole::Group)
                    .label("Text style")
                    .child(
                        view()
                            .test_id("bold")
                            .role(AccessibilityRole::Button)
                            .label("Bold")
                            .accessibility_state(move || AccessibilityState {
                                pressed: Some(if bold.get() {
                                    nsh_core::Checked::True
                                } else {
                                    nsh_core::Checked::False
                                }),
                                ..AccessibilityState::default()
                            })
                            .on_press(move || bold.update(|b| *b = !*b))
                            .child(text("B")),
                    ),
            )
            .child(
                text("Details")
                    .test_id("details")
                    .role(AccessibilityRole::Header)
                    .accessibility_level(2_u32),
            )
            .child(
                view()
                    .role(AccessibilityRole::Navigation)
                    .label("Pages")
                    .child(
                        view()
                            .test_id("page-2")
                            .role(AccessibilityRole::Link)
                            .accessibility_state(AccessibilityState {
                                current: Some(nsh_core::AccessibilityCurrent::Page),
                                ..AccessibilityState::default()
                            })
                            .child(text("2")),
                    ),
            )
    }

    #[test]
    fn roles_find_groups_and_states_follow_a_toggle() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Formatting>())).unwrap();
        app.first_render().unwrap();
        let screen = app.screen();
        assert_eq!(screen.count("role:group[Text style]"), Ok(1));
        assert_eq!(screen.count("role:navigation[Pages] >> role:link"), Ok(1));
        assert_eq!(screen.accessibility_level("id:details"), Ok(Some(2)));
        assert_eq!(
            screen.accessibility_state("id:page-2").map(|s| s.current),
            Ok(Some(nsh_core::AccessibilityCurrent::Page))
        );
        let pressed = |app: &Headless| {
            app.screen()
                .accessibility_state("role:button[Bold]")
                .map(|s| s.pressed)
        };
        assert_eq!(pressed(&app), Ok(Some(nsh_core::Checked::False)));
        app.press("role:button[Bold]").unwrap();
        app.wait(Duration::from_millis(50)).unwrap();
        assert_eq!(pressed(&app), Ok(Some(nsh_core::Checked::True)));
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

    /// A chat composer: a multiline input that submits on return, and a
    /// single-line one beside it.
    #[component]
    fn Composer() -> impl IntoElement {
        let draft = signal(String::new());
        let sent = signal(String::new());
        let title = signal(String::new());
        view()
            .child(
                input()
                    .test_id("draft")
                    .multiline(true)
                    .submit_behavior(SubmitBehavior::Submit)
                    .value(move || draft.get())
                    .on_change(move |text: &str| draft.set(text.to_owned()))
                    .on_submit(move |text: &str| sent.set(text.to_owned())),
            )
            .child(
                input()
                    .test_id("title")
                    .on_submit(move |text: &str| title.set(text.to_owned())),
            )
            .child(text(move || format!("Draft: {:?}", draft.get())))
            .child(text(move || format!("Sent: {:?}", sent.get())))
            .child(text(move || format!("Title: {:?}", title.get())))
    }

    #[test]
    fn shift_or_alt_return_breaks_the_line_of_a_multiline_input_that_submits() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Composer>())).unwrap();
        app.first_render().unwrap();
        app.type_text("id:draft", "Hi").unwrap();
        // Shift+Return and Alt (Option)+Return break the line, as on every
        // platform; Return sends.
        app.press_key("shift+enter").unwrap();
        app.type_text("id:draft", "there").unwrap();
        app.press_key("alt+enter").unwrap();
        app.type_text("id:draft", "!").unwrap();
        app.wait_for(r#"Draft: "Hi\nthere\n!""#).unwrap();
        assert!(app.shows(r#"Sent: """#));
        app.press_key("enter").unwrap();
        app.wait_for(r#"Sent: "Hi\nthere\n!""#).unwrap();
        // A single line holds no line break: Shift+Return submits it.
        app.type_text("id:title", "Plan").unwrap();
        app.press_key("shift+enter").unwrap();
        app.wait_for(r#"Title: "Plan""#).unwrap();
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
                    .on_press(move || presses.update(|p| *p += 1))
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

    /// A card that opens something when pressed, a chart in it that is a
    /// stop of Tab without taking presses (its arrow key steps while it
    /// has the focus), and a button.
    #[component]
    fn FocusStops() -> impl IntoElement {
        let opens = signal(0_u32);
        let presses = signal(0_u32);
        let steps = signal(0_u32);
        let focused = signal(false);
        effect(move || {
            if focused.get() {
                on_key("right", move |_| steps.update(|s| *s += 1));
            }
        });
        view()
            .flex_1()
            .child(
                view()
                    .test_id("card")
                    .on_press(move || opens.update(|o| *o += 1))
                    .child(
                        view()
                            .test_id("chart")
                            .h(px(40.0))
                            .focusable(true)
                            .on_focus(move || focused.set(true))
                            .on_blur(move || focused.set(false)),
                    ),
            )
            .child(
                view()
                    .test_id("button")
                    .on_press(move || presses.update(|p| *p += 1))
                    .child(text("Button")),
            )
            .child(text(move || {
                format!(
                    "Opens {} presses {} steps {} focused {}",
                    opens.get(),
                    presses.get(),
                    steps.get(),
                    focused.get()
                )
            }))
    }

    /// A page with two buttons and a dialog over it, open at first, with
    /// two buttons of its own.
    #[component]
    fn PageUnderDialog() -> impl IntoElement {
        let open = signal(true);
        let button = move |id: &'static str| {
            view()
                .test_id(id)
                .on_press(move || {
                    if id == "close" {
                        open.set(false);
                    }
                })
                .child(text(id))
        };
        view()
            .flex_1()
            .child(button("settings"))
            .child(button("help"))
            .child(dynamic(move || {
                open.get().then(|| {
                    nsh_base::dialog()
                        .child(button("confirm"))
                        .child(button("close"))
                })
            }))
    }

    #[test]
    fn tab_stays_in_the_newest_dialog_as_on_the_desktops() {
        let mut config = EngineConfig::new(Root::of::<PageUnderDialog>());
        config.environment.os = Os::MacOs;
        config.environment.idiom = nsh_core::platform::Idiom::Desktop;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        let id = |app: &Headless, s: &str| match app.screen().view(&Selector::parse(s).unwrap()) {
            crate::screen::Pick::One(id) => id,
            _ => panic!("{s} is shown"),
        };
        let (confirm, close) = (id(&app, "id:confirm"), id(&app, "id:close"));
        // Into the dialog, around inside it, never to the page under it.
        app.press_key("tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(confirm));
        app.press_key("tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(close));
        app.press_key("tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(confirm));
        app.press_key("shift+tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(close));
        // Closed: Tab goes through the page again.
        app.press_key("return").unwrap();
        app.wait_for_gone("id:close", Duration::from_secs(2))
            .unwrap();
        let (settings, help) = (id(&app, "id:settings"), id(&app, "id:help"));
        app.press_key("tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(settings));
        app.press_key("tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(help));
    }

    /// A page with a button before the one that opens a dialog, which
    /// closes on Escape or on its own `close` button.
    #[component]
    fn DialogFromButton() -> impl IntoElement {
        let open = signal(false);
        let button = move |id: &'static str| {
            view()
                .test_id(id)
                .on_press(move || open.set(id == "open"))
                .child(text(id))
        };
        view()
            .flex_1()
            .child(button("other"))
            .child(button("open"))
            .child(dynamic(move || {
                open.get().then(|| {
                    nsh_base::dialog()
                        .close_on_escape(true)
                        .on_close(move || open.set(false))
                        .child(button("confirm"))
                        .child(button("close"))
                })
            }))
    }

    #[test]
    fn a_closed_dialog_gives_the_focus_back_as_on_the_desktops() {
        for os in [Os::MacOs, Os::Linux, Os::Web] {
            let mut config = EngineConfig::new(Root::of::<DialogFromButton>());
            config.environment.os = os;
            config.environment.idiom = nsh_core::platform::Idiom::Desktop;
            let mut app = Headless::start(config).unwrap();
            app.first_render().unwrap();
            let id = |app: &Headless, s: &str| match app.screen().view(&Selector::parse(s).unwrap())
            {
                crate::screen::Pick::One(id) => id,
                _ => panic!("{s} is shown"),
            };
            let opener = id(&app, "id:open");
            app.press_key("tab").unwrap();
            app.press_key("tab").unwrap();
            for close in ["escape", "app"] {
                assert_eq!(app.screen().key_focus(), Some(opener), "{os:?}");
                app.press_key("return").unwrap();
                app.wait_for("id:close").unwrap();
                // The focus leaves the page under the dialog: Return
                // presses nothing there.
                assert_eq!(app.screen().key_focus(), None, "{os:?}");
                let (confirm, closer) = (id(&app, "id:confirm"), id(&app, "id:close"));
                app.press_key("tab").unwrap();
                assert_eq!(app.screen().key_focus(), Some(confirm), "{os:?}");
                app.press_key("tab").unwrap();
                assert_eq!(app.screen().key_focus(), Some(closer), "{os:?}");
                app.press_key("tab").unwrap();
                assert_eq!(app.screen().key_focus(), Some(confirm), "{os:?}");
                app.press_key("shift+tab").unwrap();
                assert_eq!(app.screen().key_focus(), Some(closer), "{os:?}");
                if close == "escape" {
                    app.press_key("escape").unwrap();
                } else {
                    app.press_key("return").unwrap();
                }
                app.wait_for_gone("id:close", Duration::from_secs(2))
                    .unwrap();
                // Back on the button that opened it, whichever way it
                // closed.
                assert_eq!(app.screen().key_focus(), Some(opener), "{os:?} {close}");
            }
        }
    }

    #[test]
    fn tab_stops_at_a_focusable_view_that_takes_no_presses() {
        let mut config = EngineConfig::new(Root::of::<FocusStops>());
        config.environment.os = Os::MacOs;
        config.environment.idiom = nsh_core::platform::Idiom::Desktop;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        let id = |app: &Headless, s: &str| match app.screen().view(&Selector::parse(s).unwrap()) {
            crate::screen::Pick::One(id) => id,
            _ => panic!("{s} is shown"),
        };
        let (card, chart, button) = (
            id(&app, "id:card"),
            id(&app, "id:chart"),
            id(&app, "id:button"),
        );
        assert_eq!(app.screen().tab_stops(), [card, chart, button]);
        // In tree order: the card, then the chart inside it.
        app.press_key("tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(card));
        app.press_key("tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(chart));
        app.wait_for("Opens 0 presses 0 steps 0 focused true")
            .unwrap();
        // Return presses nothing there; its keys reach it through the
        // keymap while it has the focus.
        app.press_key("enter").unwrap();
        app.press_key("right").unwrap();
        app.wait_for("Opens 0 presses 0 steps 1 focused true")
            .unwrap();
        app.press_key("tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(button));
        app.wait_for("Opens 0 presses 0 steps 1 focused false")
            .unwrap();
        app.press_key("right").unwrap();
        app.press_key("enter").unwrap();
        app.wait_for("Opens 0 presses 1 steps 1 focused false")
            .unwrap();
        app.press_key("shift+tab").unwrap();
        assert_eq!(app.screen().key_focus(), Some(chart));
        app.wait_for("Opens 0 presses 1 steps 1 focused true")
            .unwrap();
        // A press on the chart is the card's: being focusable takes none.
        app.press("id:chart").unwrap();
        app.wait_for("Opens 1 presses 1 steps 1 focused false")
            .unwrap();
    }

    /// A dialog whose Return allows (a global binding, outside text
    /// fields), Mod+Return too, with an input and two buttons.
    #[component]
    fn ReturnAllows() -> impl IntoElement {
        let allows = signal(0_u32);
        let denies = signal(0_u32);
        let cancels = signal(0_u32);
        let sends = signal(0_u32);
        on_key_with(
            "enter",
            KeyOptions {
                when: nsh_core::keymap::When::NotEditing,
                ..Default::default()
            },
            move |_| allows.update(|a| *a += 1),
        );
        on_key("mod+enter", move |_| sends.update(|s| *s += 1));
        view()
            .flex_1()
            .child(input().test_id("note"))
            .child(
                view()
                    .test_id("deny")
                    .on_press(move || denies.update(|d| *d += 1))
                    .child(text("Deny")),
            )
            .child(
                view()
                    .test_id("cancel")
                    .on_press(move || cancels.update(|c| *c += 1))
                    .child(text("Cancel")),
            )
            .child(text(move || {
                format!(
                    "Allows {} denies {} cancels {} sends {}",
                    allows.get(),
                    denies.get(),
                    cancels.get(),
                    sends.get()
                )
            }))
    }

    #[test]
    fn return_and_space_press_the_focused_control_before_the_shortcuts() {
        for os in [Os::MacOs, Os::Web, Os::Linux] {
            let mut config = EngineConfig::new(Root::of::<ReturnAllows>());
            config.environment.os = os;
            config.environment.idiom = nsh_core::platform::Idiom::Desktop;
            let mut app = Headless::start(config).unwrap();
            app.first_render().unwrap();
            // The focus on no control: Return is the dialog's.
            app.press_key("enter").unwrap();
            app.wait_for("Allows 1 denies 0 cancels 0 sends 0").unwrap();
            // Tab to Deny, then Cancel: Return and Space press the control
            // the focus is on, not the binding.
            app.press_key("tab").unwrap();
            app.press_key("tab").unwrap();
            app.press_key("enter").unwrap();
            app.wait_for("Allows 1 denies 1 cancels 0 sends 0")
                .unwrap_or_else(|e| panic!("{os:?}: {e}"));
            app.press_key("space").unwrap();
            app.wait_for("Allows 1 denies 2 cancels 0 sends 0").unwrap();
            app.press_key("tab").unwrap();
            app.press_key("enter").unwrap();
            app.wait_for("Allows 1 denies 2 cancels 1 sends 0").unwrap();
            // With Mod held the binding of that keystroke fires.
            app.press_key("mod+enter").unwrap();
            app.wait_for("Allows 1 denies 2 cancels 1 sends 1").unwrap();
            // In the text field Return is the field's: no binding (it fires
            // outside text fields), no control.
            app.type_text("id:note", "Hi").unwrap();
            app.press_key("enter").unwrap();
            app.wait_for("Allows 1 denies 2 cancels 1 sends 1").unwrap();
            app.press_key("mod+enter").unwrap();
            app.wait_for("Allows 1 denies 2 cancels 1 sends 2").unwrap();
        }
    }

    /// A list of 200 rows of its own, each a button showing its row.
    #[component]
    fn LongList() -> impl IntoElement {
        virtual_list(200, |at| {
            view()
                .h(px(40.0))
                .on_press(|| {})
                .child(text(move || format!("Row {}", at.index())))
        })
        .test_id("list")
        .estimated_item_size(px(40.0))
        .flex_1()
    }

    /// Scrolled back and forth, a list's cells are recycled out of the order
    /// they were made in: what reads the screen, Tab and `nth=` still find
    /// its rows in the order they show.
    #[test]
    fn a_lists_recycled_rows_are_found_in_screen_order() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<LongList>())).unwrap();
        app.first_render().unwrap();
        for distance in [
            300.0, 500.0, -200.0, 900.0, -700.0, 1300.0, -400.0, 250.0, -1100.0, 800.0,
        ] {
            app.scroll("id:list", px(distance)).unwrap();
        }
        let rows: Vec<u32> = app
            .screen()
            .texts()
            .iter()
            .filter_map(|t| t.strip_prefix("Row ")?.parse().ok())
            .collect();
        assert!(rows.len() > 10, "{rows:?}");
        assert!(rows.windows(2).all(|w| w[1] == w[0] + 1), "{rows:?}");
        // Tab's stops are the rows' buttons, in the same order.
        assert_eq!(app.screen().tab_stops().len(), rows.len());
    }

    /// A page: a header and a list of 200 rows in the page's viewport.
    #[component]
    fn LongPage() -> impl IntoElement {
        scroll()
            .test_id("page")
            .flex_1()
            .child(text("Header").h(px(120.0)))
            .child(
                virtual_list(200, |at| {
                    view()
                        .h(px(40.0))
                        .on_press(|| {})
                        .child(text(move || format!("Row {}", at.index())))
                })
                .viewport(nsh_core::ListViewport::Parent)
                .estimated_item_size(px(40.0)),
            )
    }

    /// The same for a list in its parent's viewport: a plain view in the
    /// page, its cells read in screen order all the same.
    #[test]
    fn a_page_lists_recycled_rows_are_found_in_screen_order() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<LongPage>())).unwrap();
        app.first_render().unwrap();
        for distance in [
            300.0, 500.0, -200.0, 900.0, -700.0, 1300.0, -400.0, 250.0, -1100.0, 800.0,
        ] {
            app.scroll("id:page", px(distance)).unwrap();
        }
        let rows: Vec<u32> = app
            .screen()
            .texts()
            .iter()
            .filter_map(|t| t.strip_prefix("Row ")?.parse().ok())
            .collect();
        assert!(rows.len() > 10, "{rows:?}");
        assert!(rows.windows(2).all(|w| w[1] == w[0] + 1), "{rows:?}");
        assert_eq!(app.screen().tab_stops().len(), rows.len());
    }

    /// A short list of 30 rows of its own, four on screen, each a button
    /// that says when it has the focus, and a button after it.
    #[component]
    fn TabbedList() -> impl IntoElement {
        let focused = signal(String::from("none"));
        view()
            .flex_1()
            .child(
                virtual_list(30, move |at| {
                    view()
                        .h(px(40.0))
                        .on_press(|| {})
                        .on_focus(move || focused.set(format!("row {}", at.index())))
                        .child(text(move || format!("Row {}", at.index())))
                })
                .test_id("list")
                .estimated_item_size(px(40.0))
                .h(px(160.0)),
            )
            .child(
                view()
                    .test_id("after")
                    .h(px(40.0))
                    .on_press(|| {})
                    .on_focus(move || focused.set("after".into()))
                    .child(text("After")),
            )
            .child(text(move || format!("Focused {}.", focused.get())))
    }

    /// Tab walks a list's rows one by one, those not rendered yet too, the
    /// list scrolling each into view, and leaves it after its last row;
    /// Shift+Tab walks them back.
    #[test]
    fn tab_walks_every_row_of_a_list() {
        let mut config = EngineConfig::new(Root::of::<TabbedList>());
        config.environment.os = Os::MacOs;
        config.environment.idiom = nsh_core::platform::Idiom::Desktop;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        let id = |app: &Headless, s: &str| match app.screen().view(&Selector::parse(s).unwrap()) {
            crate::screen::Pick::One(id) => id,
            _ => panic!("{s} is shown"),
        };
        let list = id(&app, "id:list");
        let shows = |app: &Headless| {
            let view = app.screen().key_focus().expect("a focus");
            let (Some(row), Some(list)) = (
                app.screen().bounds_in_root(view),
                app.screen().bounds_in_root(list),
            ) else {
                return false;
            };
            row.origin.y >= list.origin.y
                && row.origin.y + row.size.height <= list.origin.y + list.size.height
        };
        let rows = (0..30).map(|i| format!("row {i}"));
        for row in rows.clone() {
            app.press_key("tab").unwrap();
            app.wait_for(&format!("Focused {row}.")).unwrap();
            assert!(shows(&app), "{row} is scrolled into view");
        }
        app.press_key("tab").unwrap();
        app.wait_for("Focused after.").unwrap();
        for row in rows.rev() {
            app.press_key("shift+tab").unwrap();
            app.wait_for(&format!("Focused {row}.")).unwrap();
            assert!(shows(&app), "{row} is scrolled into view");
        }
        // Scrolled far from the focus, Tab goes on from it, to the row
        // after it, not to the rows on screen.
        app.scroll("id:list", px(900.0)).unwrap();
        assert!(!shows(&app));
        app.press_key("tab").unwrap();
        app.wait_for("Focused row 1.").unwrap();
        assert!(shows(&app), "row 1 is scrolled into view");
    }

    /// A card's height once its content is loaded: never the list's
    /// estimate, cards before the 50th growing by `grown` once "Grow" is
    /// pressed. Before, a placeholder of 30 points.
    fn card_height(i: usize, loaded: bool, grown: f32) -> f32 {
        if !loaded {
            return 30.0;
        }
        60.0 + (i % 4) as f32 * 50.0 + if i < 50 { grown } else { 0.0 }
    }

    /// 200 cards estimated at 40 points, placeholders until "Load" is
    /// pressed, in a list of its own or in a page's viewport (below a
    /// header); "Go" scrolls the list to card 50, "Grow" makes the cards
    /// before it taller.
    fn cards(viewport: nsh_core::ListViewport, alignment: nsh_core::ListAlignment) -> AnyElement {
        let list = element_ref();
        let loaded = signal(false);
        let grown = signal(0.0f32);
        let cards = virtual_list(200, move |at| {
            view()
                .h(move || Length::from(px(card_height(at.index(), loaded.get(), grown.get()))))
                .child(text(move || format!("Card {}", at.index())))
        })
        .element_ref(&list)
        .estimated_item_size(px(40.0))
        .viewport(viewport)
        .alignment(alignment);
        let controls =
            view()
                .flex_row()
                .child(text("Go").on_press(move |_: &()| {
                    list.scroll_to_index(50, percentage(0.0), px(0.0), false)
                }))
                .child(text("Load").on_press(move |_: &()| loaded.set(true)))
                .child(text("Grow").on_press(move |_: &()| grown.set(40.0)));
        match viewport {
            nsh_core::ListViewport::Own => view()
                .flex_1()
                .child(controls)
                .child(cards.test_id("viewport").flex_1())
                .into_element(),
            _ => view()
                .flex_1()
                .child(controls)
                .child(
                    scroll()
                        .test_id("viewport")
                        .flex_1()
                        .child(text("Header").h(px(120.0)))
                        .child(cards),
                )
                .into_element(),
        }
    }

    #[component]
    fn OwnCards() -> impl IntoElement {
        cards(nsh_core::ListViewport::Own, nsh_core::ListAlignment::Top)
    }

    #[component]
    fn PageCards() -> impl IntoElement {
        cards(nsh_core::ListViewport::Parent, nsh_core::ListAlignment::Top)
    }

    #[component]
    fn BottomCards() -> impl IntoElement {
        cards(nsh_core::ListViewport::Own, nsh_core::ListAlignment::Bottom)
    }

    /// The distance from the top of the viewport to the top of `label`'s
    /// text, `None` while it is not shown.
    fn from_top(app: &Headless, label: &str) -> Option<f32> {
        let pick = |s: &str| match app.screen().view(&Selector::parse(s).unwrap()) {
            crate::screen::Pick::One(id) => app.screen().bounds_in_root(id),
            _ => None,
        };
        let viewport = pick("id:viewport")?;
        let card = pick(label)?;
        Some(card.origin.y.0 - viewport.origin.y.0)
    }

    /// Scrolled to a card, a list keeps it at the top of its viewport as
    /// the cards above it are measured at heights other than the estimate,
    /// as their content loads after the scroll (all the cards around the
    /// viewport changing in one layout) and as they grow later: the rows
    /// above the viewport anchor the visible ones, whether the list scrolls
    /// itself or its page does.
    #[test]
    fn rows_measured_above_the_viewport_keep_the_visible_row_in_place() {
        let at_top = |app: &Headless, by: f32, what: &str| {
            let at = from_top(app, "Card 50");
            assert!(
                at.is_some_and(|y| (y + by).abs() < 1.0),
                "{what}: card 50 at {at:?}"
            );
        };
        for (name, root) in [
            ("own", Root::of::<OwnCards> as fn() -> Root),
            ("page", Root::of::<PageCards>),
        ] {
            // Measured from the estimate.
            let mut app = Headless::start(EngineConfig::new(root())).unwrap();
            app.first_render().unwrap();
            app.press("Load").unwrap();
            app.press("Go").unwrap();
            app.wait(Duration::from_millis(500)).unwrap();
            at_top(&app, 0.0, &format!("{name}, measured"));

            // Placeholders, then content.
            let mut app = Headless::start(EngineConfig::new(root())).unwrap();
            app.first_render().unwrap();
            app.press("Go").unwrap();
            app.wait(Duration::from_millis(500)).unwrap();
            at_top(&app, 0.0, &format!("{name}, placeholders"));
            // Scrolled a little, the scroll command's target is let go.
            app.scroll("id:viewport", px(10.0)).unwrap();
            app.wait(Duration::from_millis(200)).unwrap();
            at_top(&app, 10.0, &format!("{name}, scrolled"));
            app.press("Load").unwrap();
            app.wait(Duration::from_millis(500)).unwrap();
            at_top(&app, 10.0, &format!("{name}, loaded"));
            // The cards above it grow: it stays where it is.
            app.press("Grow").unwrap();
            app.wait(Duration::from_millis(500)).unwrap();
            at_top(&app, 10.0, &format!("{name}, grown"));
        }
    }

    /// A bottom-aligned list rests at its end while the cards above the
    /// viewport are measured and their content loads: it anchors to its
    /// end, not to its first visible row.
    #[test]
    fn a_bottom_aligned_list_stays_at_its_end_as_rows_above_are_measured() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<BottomCards>())).unwrap();
        app.first_render().unwrap();
        app.wait(Duration::from_millis(500)).unwrap();
        // How far above the viewport's end card 199's text starts: at the
        // top of its card.
        let from_end = |app: &Headless| {
            let pick = |s: &str| match app.screen().view(&Selector::parse(s).unwrap()) {
                crate::screen::Pick::One(id) => app.screen().bounds_in_root(id),
                _ => None,
            };
            let viewport = pick("id:viewport")?;
            let card = pick("Card 199")?;
            Some(viewport.origin.y.0 + viewport.size.height.0 - card.origin.y.0)
        };
        let at = from_end(&app);
        assert!(
            at.is_some_and(|d| (d - 30.0).abs() < 1.0),
            "placeholder {at:?} above the end"
        );
        app.press("Load").unwrap();
        app.wait(Duration::from_millis(500)).unwrap();
        // 210 points tall loaded.
        let at = from_end(&app);
        assert!(
            at.is_some_and(|d| (d - 210.0).abs() < 1.0),
            "card 199 {at:?} above the end"
        );
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

    /// Saves to the path the user chooses and shows it in the file manager.
    #[component]
    fn SaveAs() -> impl IntoElement {
        let saved = signal(String::from("none"));
        view()
            .child(text(move || format!("Saved {}", saved.get())))
            .child(text("Save").on_press(move |_: &()| {
                let dialog = nsh_core::file_dialog::SaveDialog::new().file_name("Untitled.md");
                let path = pick_save_path(dialog);
                spawn(async move {
                    let path = match path.await {
                        Ok(Some(path)) => path,
                        Ok(None) => return saved.set("cancelled".into()),
                        Err(_) => return saved.set("unavailable".into()),
                    };
                    let shown = reveal_path(path.clone()).await.is_ok();
                    saved.set(format!("{} {shown}", path.display()));
                });
            }))
    }

    #[test]
    fn the_save_dialog_answers_with_the_path_the_test_chose() {
        use nsh_core::file_dialog::FileRequest;
        let mut app = Headless::start(EngineConfig::new(Root::of::<SaveAs>())).unwrap();
        app.first_render().unwrap();
        // No file dialogs on this platform: unavailable at once.
        app.press("Save").unwrap();
        app.wait_for("Saved unavailable").unwrap();
        assert!(app.screen().file_requests().is_empty());
        app.on_pick_save_path(None).unwrap();
        app.press("Save").unwrap();
        app.wait_for("Saved cancelled").unwrap();
        app.on_pick_save_path(Some("/docs/a.md".into())).unwrap();
        app.press("Save").unwrap();
        app.wait_for("Saved /docs/a.md true").unwrap();
        let requests = app.screen().file_requests();
        assert_eq!(requests.len(), 3);
        assert!(matches!(
            &requests[1],
            FileRequest::SaveDialog(save) if save.file_name.as_deref() == Some("Untitled.md")
        ));
        assert_eq!(requests[2], FileRequest::RevealPath("/docs/a.md".into()));
    }

    /// A clipping box with padding that holds a label, a box wider than it,
    /// a hidden box and a horizontal scroll view.
    #[component]
    fn Laid() -> impl IntoElement {
        view()
            .test_id("outer")
            .w(px(200.0))
            .h(px(100.0))
            .p(px(10.0))
            .overflow_hidden()
            .child(text("Label").test_id("label"))
            .child(view().test_id("wide").w(px(300.0)).h(px(20.0)))
            .child(view().test_id("ghost").w(px(10.0)).h(px(10.0)).invisible())
            .child(
                scroll()
                    .test_id("strip")
                    .horizontal()
                    .w(px(100.0))
                    .h(px(30.0))
                    .child(view().test_id("long").w(px(400.0)).h(px(30.0))),
            )
    }

    fn node<'a>(nodes: &'a [crate::LayoutNode], test_id: &str) -> &'a crate::LayoutNode {
        nodes
            .iter()
            .find(|n| n.test_id.as_deref() == Some(test_id))
            .unwrap_or_else(|| panic!("no {test_id} in {nodes:?}"))
    }

    #[test]
    fn layout_nodes_give_each_views_box_parent_clip_and_text_box() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Laid>())).unwrap();
        app.first_render().unwrap();
        let nodes = app.screen().layout_nodes();

        // Tree order, the root left out, and every parent is in the list.
        let ids: Vec<_> = nodes.iter().map(|n| n.id).collect();
        let outer = node(&nodes, "outer");
        assert_eq!(outer.parent, ROOT_ID);
        assert_eq!(outer.kind, nsh_core::ViewKind::View);
        assert_eq!(ids[0], outer.id);
        for n in nodes.iter().filter(|n| n.id != outer.id) {
            assert!(ids.contains(&n.parent), "{n:?}");
        }

        // Boxes are in the root's points; padding moves the children.
        assert_eq!(outer.bounds.size, Size::new(px(200.0), px(100.0)));
        assert!(outer.clips);
        assert!(outer.scroll.is_none() && outer.text.is_none() && !outer.hidden);
        let wide = node(&nodes, "wide");
        assert_eq!(wide.parent, outer.id);
        assert_eq!(wide.bounds.origin.x, outer.bounds.origin.x + px(10.0));
        // It is wider than the box that clips it: the audit's evidence.
        assert!(wide.bounds.right() > outer.bounds.right());

        // A hidden view keeps its box; a scroll view says which way it
        // scrolls and how large its content is.
        assert!(node(&nodes, "ghost").hidden);
        let strip = node(&nodes, "strip");
        let scrolling = strip.scroll.as_ref().unwrap();
        assert!(scrolling.horizontal);
        assert_eq!(scrolling.content_size.map(|s| s.width), Some(px(400.0)));
        assert_eq!(node(&nodes, "long").parent, strip.id);

        // A text keeps its attributed text and the box it was laid out in,
        // in the root's points as its own box.
        let label = node(&nodes, "label");
        let text = label.text.as_ref().unwrap();
        assert_eq!(text.text.text, "Label");
        assert!(text.content.size.width.0 > 0.0);
        assert!(text.content.origin.x >= label.bounds.origin.x);
        assert!(text.content.right() <= label.bounds.right());
    }

    #[test]
    fn layout_nodes_follow_scroll_offsets() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<Rows>())).unwrap();
        app.first_render().unwrap();
        let row = |app: &Headless| {
            let nodes = app.screen().layout_nodes();
            let text = nodes
                .iter()
                .find(|n| n.text.as_ref().is_some_and(|t| t.text.text == "Row 3"))
                .unwrap()
                .clone();
            // The row's box is the text's parent.
            let parent = nodes.iter().find(|n| n.id == text.parent).unwrap();
            parent.bounds.origin.y
        };
        let before = row(&app);
        app.scroll("Row 3", px(100.0)).unwrap();
        app.wait_for("At 100").unwrap();
        assert_eq!(row(&app), before - px(100.0));
    }

    /// Counts the texts it prepares, so a test sees which engine laid out.
    #[derive(Clone, Default)]
    struct Counting(Arc<std::sync::atomic::AtomicUsize>);

    impl TextEngine for Counting {
        type Prepared = <ApproxTextEngine as TextEngine>::Prepared;

        fn prepare(&self, text: &nsh_core::AttributedText) -> Self::Prepared {
            self.0.fetch_add(1, Ordering::Relaxed);
            ApproxTextEngine.prepare(text)
        }

        fn measure(&self, prepared: &Self::Prepared, max_width: Option<Points>) -> Size<Points> {
            ApproxTextEngine.measure(prepared, max_width)
        }

        fn layout(&self, prepared: &Self::Prepared, size: Size<Points>) -> nsh_core::TextLayout {
            ApproxTextEngine.layout(prepared, size)
        }
    }

    #[test]
    fn start_with_text_engine_lays_text_out_with_the_given_engine() {
        let counting = Counting::default();
        let seen = counting.0.clone();
        let mut app =
            Headless::start_with_text_engine(EngineConfig::new(Root::of::<Laid>()), move || {
                counting
            })
            .unwrap();
        app.first_render().unwrap();
        assert!(seen.load(Ordering::Relaxed) > 0);
        assert!(app.shows("Label"));
    }

    // Escape bound in the main window and in a window of the app's own.
    #[component]
    fn WindowKeys() -> impl IntoElement {
        let main = signal(0);
        let settings = signal(0);
        on_key("escape", move |_| main.update(|n| *n += 1));
        view()
            .child(
                text(move || format!("keys {} {}", main.get(), settings.get()))
                    .test_id("in-main")
                    .on_press(|_: &()| {}),
            )
            .child(
                nsh_core::element::desktop::window()
                    .id("settings")
                    .default_size(size(px(300.0), px(100.0)))
                    .content(move || {
                        on_key("escape", move |_| settings.update(|n| *n += 1));
                        view()
                            .test_id("in-settings")
                            .on_press(|_: &()| {})
                            .w(px(100.0))
                            .h(px(40.0))
                    }),
            )
    }

    #[test]
    fn a_key_fires_the_bindings_of_the_focused_window() {
        let mut config = EngineConfig::new(Root::of::<WindowKeys>());
        config.environment.os = Os::MacOs;
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        app.wait_for("keys 0 0").unwrap();
        // Settings opened focused: its binding takes the key, main's not.
        app.press_key("escape").unwrap();
        app.wait_for("keys 0 1").unwrap();
        // A press in the main window focuses it, and then its binding.
        app.press("id:in-main").unwrap();
        app.press_key("escape").unwrap();
        app.wait_for("keys 1 1").unwrap();
        app.press("id:in-settings").unwrap();
        app.press_key("escape").unwrap();
        app.wait_for("keys 1 2").unwrap();
    }

    /// A layout chosen by the window's width, and the color scheme.
    #[component]
    fn ByWidth() -> impl IntoElement {
        text(move || {
            let width = nsh_core::element::window().width.0;
            let layout = if width < 600.0 { "narrow" } else { "wide" };
            let scheme = if nsh_core::element::dark() {
                "dark"
            } else {
                "light"
            };
            format!("{layout} {width} {scheme}")
        })
    }

    fn open_by_width(os: nsh_core::platform::Os) -> Headless {
        let mut config = EngineConfig::new(Root::of::<ByWidth>());
        config.environment.os = os;
        config.viewport = Size::new(px(800.0), px(600.0));
        let mut app = Headless::start(config).unwrap();
        app.first_render().unwrap();
        app
    }

    #[test]
    fn a_changed_environment_keeps_the_window_size() {
        for os in [nsh_core::platform::Os::Ios, nsh_core::platform::Os::MacOs] {
            let mut app = open_by_width(os);
            app.wait_for("wide 800 light").unwrap();
            // A step that changes only the color scheme keeps the window.
            app.set_environment("setColorScheme(dark)", |env| {
                env.color_scheme = nsh_core::platform::ColorScheme::Dark;
            })
            .unwrap();
            app.wait_for("wide 800 dark").unwrap();
            // A resized window, then another change of the environment.
            app.set_viewport(Size::new(px(390.0), px(844.0))).unwrap();
            app.wait_for("narrow 390 dark").unwrap();
            app.set_environment("setColorScheme(light)", |env| {
                env.color_scheme = nsh_core::platform::ColorScheme::Light;
            })
            .unwrap();
            app.wait_for("narrow 390 light").unwrap();
        }
    }
}
