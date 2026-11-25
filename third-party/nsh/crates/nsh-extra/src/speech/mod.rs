//! `Speech` (feature `speech`): speech recognition (dictation). The user
//! speaks, the app gets the transcript as it grows.
//!
//! A session starts with a [`SpeechRequest`] ([`recognize`]; TS:
//! `Speech.start`): the platform asks for the microphone and the recognizer
//! (the system's prompts, once), listens, and reports [`SpeechEvent`]s:
//! [`SpeechEvent::Start`] once it hears, [`SpeechEvent::Result`] with the
//! whole transcript so far each time it changes, and one
//! [`SpeechEvent::End`] (with a [`SpeechError`] when it failed), after
//! which nothing comes. Stopping a session lets the recognizer finish what
//! it heard (a last, final result, then the end); aborting it ends it at
//! once and drops what was not reported. One session runs at a time in the
//! process, whichever surface started it: the microphone is one, so
//! starting another ends the one running. A session its own engine
//! replaces ends without an error (the app started another); one another
//! engine (another app or `AppView`) displaces ends with
//! [`SpeechError::AudioCapture`]: the microphone could not be used.
//!
//! The `speech` capability guards it when the app declares capabilities:
//! `Speech.start` throws `ERR_ACCESS_DENIED` without it (checked against
//! the calling VM's grant), and a session Rust code starts in an app
//! without it ends at once with [`SpeechError::NotAllowed`] (checked
//! against the engine's, [`nsh_core::element::access`]), leaving the
//! session running alone. Rust code that runs on no engine's thread is
//! trusted and not checked. `Speech.available()` tells the platform only,
//! so it needs none.
//!
//! # Platforms
//!
//! Each platform is one file of this directory: `apple.rs` (macOS and iOS:
//! the Speech framework fed by the microphone), `android.rs`
//! (`android.speech.SpeechRecognizer`), `winrt.rs` (Windows:
//! `Windows.Media.SpeechRecognition`'s continuous dictation, which needs
//! the user's online speech recognition setting on), `web.rs` (the
//! browser's Web Speech API, through wasm-bindgen). The file follows the
//! target OS, so GPUI on macOS and Windows uses the platform's recognizer
//! too. Elsewhere nothing recognizes speech: [`available`] is false and a
//! session ends at once with [`SpeechError::Unavailable`]. That is Linux
//! (GTK or GPUI), headless runs without the fake, and the terminal host
//! (the TUI) on every OS: an engine whose idiom is
//! [`Idiom::Terminal`](nsh_core::platform::Idiom::Terminal) runs no
//! platform recognizer, whose prompts and run loop a terminal does not
//! have. A platform's file gives two functions, which this module calls:
//!
//! ```ignore
//! /// Whether the platform recognizes speech now (TS: `Speech.available()`),
//! /// without asking the user anything. In a task, on any thread.
//! pub(super) async fn available() -> bool;
//!
//! /// Starts a session for `request`, reporting to `events` (from any
//! /// thread) until its end; what controls it. Called on the engine's
//! /// thread: the platform takes the session to the thread its recognizer
//! /// runs on and never blocks the caller. A platform that cannot recognize
//! /// now ends `events` with `Unavailable`; a user who refuses, with
//! /// `NotAllowed`.
//! pub(super) fn start(request: SpeechRequest, events: SpeechSink) -> Box<dyn SpeechControl>;
//! ```
//!
//! The module owns everything else: the one session running, the
//! capability, the JS face. A new platform is one more file and one more
//! `cfg` line below.
//!
//! An embedding app recognizes speech its own way with a [`SpeechBackend`]
//! ([`set_backend`]): it runs every session, and the platform's recognizer
//! is never used. Headless runs (`nsh test`) use the module's fake
//! recognizer, which the test speaks into through `nsh/test`'s
//! `app.fake("nsh-extra/speech", method, args)`: the module gives it as
//! the fake `"nsh-extra/speech"` ([`nsh_core::fake`]); its methods are
//! documented in `fake.rs`.
//!
//! The packaged app needs the microphone's and the recognizer's usage
//! descriptions on iOS and macOS (and the microphone's entitlement under
//! macOS' hardened runtime), `RECORD_AUDIO` and the visibility of the
//! recognition service on Android: `nsh` adds them from this crate's
//! `[package.metadata.nsh.features.speech]` when the feature is on. A
//! Windows app as `nsh package` makes it needs nothing declared. On the
//! web the browser asks for the microphone itself, so a site needs no
//! declaration; `nsh` ships the wasm-bindgen glue the module calls the
//! browser through.

#[cfg(target_os = "android")]
mod android;
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple;
pub(crate) mod fake;
// Their error mapping and transcript assembly are tested on every target.
#[cfg(any(target_arch = "wasm32", test))]
mod web;
#[cfg(any(target_os = "windows", test))]
mod winrt;

use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::{Rc, Weak},
    sync::{
        Arc, Mutex, MutexGuard, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    task::{Poll, Waker},
};

use nsh_core::{
    element::{Cleanup, JsHost, JsIn, JsOwned, PropError, Ret, TsTypes, codes},
    prelude::*,
};

#[cfg(target_os = "android")]
use self::android as platform;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use self::apple as platform;
pub(crate) use self::fake::FakeSpeech;
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "android",
    target_os = "windows",
    target_arch = "wasm32"
)))]
use self::none as platform;
#[cfg(target_arch = "wasm32")]
use self::web as platform;
#[cfg(target_os = "windows")]
use self::winrt as platform;

/// What the app asked a session for.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SpeechRequest {
    /// The language spoken, a BCP 47 tag (`en-US`, `zh-CN`); `None`: the
    /// user's.
    pub lang: Option<String>,
    /// Whether results come while the user speaks (the transcript so far,
    /// not final yet), or only the final one.
    pub interim: bool,
}

impl Default for SpeechRequest {
    fn default() -> Self {
        Self {
            lang: None,
            interim: true,
        }
    }
}

/// What a session reports, in this order: [`Self::Start`], any number of
/// [`Self::Result`]s, one [`Self::End`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SpeechEvent {
    /// The microphone is on and the recognizer listens (the user granted
    /// what the system asked for).
    Start,
    /// The transcript changed.
    Result {
        /// The whole transcript of the session so far.
        text: String,
        /// The recognizer will not change it any more (the last result of
        /// a session that ends normally).
        is_final: bool,
    },
    /// The session ended: stopped, aborted, finished on its own or failed.
    End {
        /// Why it failed; `None` when it did not.
        error: Option<SpeechError>,
    },
}

/// Why a session failed (TS: the `end` event's `error`, named as the Web
/// Speech API's).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SpeechError {
    /// The user, the system or the app's capabilities do not allow the
    /// microphone or speech recognition (`not-allowed`).
    NotAllowed,
    /// Nothing was said (`no-speech`).
    NoSpeech,
    /// The microphone could not be used (`audio-capture`).
    AudioCapture,
    /// The recognizer needs the network and could not reach it
    /// (`network`).
    Network,
    /// The recognizer does not know the language asked for
    /// (`language-not-supported`).
    LanguageNotSupported,
    /// The platform recognizes no speech, or not now (`unavailable`).
    Unavailable,
    /// The recognizer failed for another reason (`failed`).
    Failed,
}

impl SpeechError {
    /// Every error, in declaration order (a slice: more may come).
    pub const ALL: &'static [SpeechError] = &[
        SpeechError::NotAllowed,
        SpeechError::NoSpeech,
        SpeechError::AudioCapture,
        SpeechError::Network,
        SpeechError::LanguageNotSupported,
        SpeechError::Unavailable,
        SpeechError::Failed,
    ];

    /// Its name, as JS gets it (`not-allowed`).
    pub fn as_str(self) -> &'static str {
        match self {
            SpeechError::NotAllowed => "not-allowed",
            SpeechError::NoSpeech => "no-speech",
            SpeechError::AudioCapture => "audio-capture",
            SpeechError::Network => "network",
            SpeechError::LanguageNotSupported => "language-not-supported",
            SpeechError::Unavailable => "unavailable",
            SpeechError::Failed => "failed",
        }
    }

    /// The error named `name` ([`Self::as_str`]).
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|e| e.as_str() == name)
    }
}

impl std::fmt::Display for SpeechError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where a session's events go: the app, from any thread. After
/// [`SpeechEvent::End`] it takes nothing more.
#[derive(Clone)]
pub struct SpeechSink {
    channel: Arc<Mutex<Channel>>,
}

#[derive(Default)]
struct Channel {
    events: VecDeque<SpeechEvent>,
    waker: Option<Waker>,
    ended: bool,
}

impl std::fmt::Debug for SpeechSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpeechSink")
            .field("ended", &self.is_ended())
            .finish()
    }
}

impl SpeechSink {
    fn channel(&self) -> MutexGuard<'_, Channel> {
        self.channel.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reports `event`; `false` (and nothing reported) once the session
    /// ended. An [`SpeechEvent::End`] ends it.
    pub fn send(&self, event: SpeechEvent) -> bool {
        let waker = {
            let mut channel = self.channel();
            if channel.ended {
                return false;
            }
            channel.ended = matches!(event, SpeechEvent::End { .. });
            channel.events.push_back(event);
            channel.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
        true
    }

    /// Reports that the recognizer listens ([`SpeechEvent::Start`]).
    pub fn start(&self) -> bool {
        self.send(SpeechEvent::Start)
    }

    /// Reports the transcript so far ([`SpeechEvent::Result`]).
    pub fn result(&self, text: impl Into<String>, is_final: bool) -> bool {
        self.send(SpeechEvent::Result {
            text: text.into(),
            is_final,
        })
    }

    /// Ends the session ([`SpeechEvent::End`]), with `error` when it failed.
    pub fn end(&self, error: Option<SpeechError>) -> bool {
        self.send(SpeechEvent::End { error })
    }

    /// Whether the session ended: nothing more is reported.
    pub fn is_ended(&self) -> bool {
        self.channel().ended
    }
}

/// The receiving end of a session's [`SpeechSink`].
struct SpeechEvents {
    channel: Arc<Mutex<Channel>>,
}

impl SpeechEvents {
    /// The next event; `None` after the end was taken.
    fn poll_next(&mut self, cx: &mut std::task::Context<'_>) -> Poll<Option<SpeechEvent>> {
        let mut channel = self.channel.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(event) = channel.events.pop_front() {
            return Poll::Ready(Some(event));
        }
        if channel.ended {
            return Poll::Ready(None);
        }
        channel.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

/// A session's sink and the events it reports.
fn channel() -> (SpeechSink, SpeechEvents) {
    let channel = Arc::new(Mutex::new(Channel::default()));
    (
        SpeechSink {
            channel: channel.clone(),
        },
        SpeechEvents { channel },
    )
}

/// A running session of a [`SpeechBackend`] or of the platform: the
/// module calls it from the thread the app's code runs on, so it takes the
/// call to its recognizer's thread itself and never blocks.
pub trait SpeechControl: Send {
    /// Stops listening and finishes recognizing what was heard: the last
    /// result, then the end, through the session's sink.
    fn stop(&mut self);
    /// Ends the session at once, its microphone off. The module already
    /// ended the sink: what is reported after this is dropped.
    fn abort(&mut self);
}

/// Recognizes speech in place of the platform: an embedding app's own
/// recognizer, or a test's fake. Its functions must not call this module's
/// (they run while it holds the session).
pub trait SpeechBackend: Send + Sync {
    /// Whether it recognizes speech now (TS: `Speech.available()`).
    fn available(&self) -> bool {
        true
    }

    /// Starts a session for `request`, reporting to `events` (from any
    /// thread) until it ends; what controls it.
    fn start(&self, request: SpeechRequest, events: SpeechSink) -> Box<dyn SpeechControl>;
}

/// The backend answering in place of the platform ([`set_backend`]).
static BACKEND: RwLock<Option<Arc<dyn SpeechBackend>>> = RwLock::new(None);

/// Recognizes every session with `backend` from now on (`None`: the
/// platform's recognizer again). Process-wide on purpose, as the session
/// is: there is one microphone, and the module's code is the process's,
/// whichever surface asks. A session running keeps its recognizer.
pub fn set_backend(backend: Option<Arc<dyn SpeechBackend>>) {
    *BACKEND.write().unwrap_or_else(|e| e.into_inner()) = backend;
}

fn backend() -> Option<Arc<dyn SpeechBackend>> {
    BACKEND.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Whether speech can be recognized here: on macOS, iOS, Android and
/// Windows devices with a recognizer (Android: a recognition service
/// installed; Windows: a dictation language and a microphone), in browsers
/// with the Web Speech API, or with a [`SpeechBackend`] that recognizes
/// it; not on Linux nor in a terminal (the TUI host, on every OS). Whether
/// the user allows the microphone is asked when a session starts. In a
/// task.
pub async fn available() -> bool {
    match backend() {
        Some(backend) => backend.available(),
        None if in_terminal() => none::available().await,
        None => platform::available().await,
    }
}

/// Whether the calling engine draws in a terminal (the TUI host, on any
/// OS): no platform recognizer runs there, whose prompts and main run
/// loop a terminal host does not have.
fn in_terminal() -> bool {
    // `idiom` needs an engine's environment, which `try_os` tells is there.
    nsh_core::element::try_os().is_some()
        && nsh_core::element::idiom() == nsh_core::platform::Idiom::Terminal
}

/// The session running in the process, until the next one replaces it or
/// its owner sees its end.
struct Running {
    id: u64,
    /// The engine that started it; `None`: Rust code on no engine's
    /// thread, an owner of its own.
    owner: Option<nsh_core::element::EngineId>,
    sink: SpeechSink,
    control: Box<dyn SpeechControl>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn running() -> MutexGuard<'static, Option<Running>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Ends the session `running` at once, with `error`, and turns its
/// recognizer off (unless it already ended).
fn abort(running: Running, error: Option<SpeechError>) {
    let Running {
        sink, mut control, ..
    } = running;
    if sink.end(error) {
        control.abort();
    }
}

/// How a session `owner` starts ends the one `running`: without an error
/// when its own engine replaces it, with [`SpeechError::AudioCapture`]
/// when another engine takes the microphone.
fn displaced(running: &Running, owner: Option<nsh_core::element::EngineId>) -> Option<SpeechError> {
    (running.owner != owner).then_some(SpeechError::AudioCapture)
}

/// Starts recognizing what the user says (TS: `Speech.start`), as
/// `request` asks: the session's events come from
/// [`SpeechRecognition::next`], in a task. One session runs at a time:
/// starting another ends the one running (its [`SpeechEvent::End`]:
/// without an error when the same engine started it, with
/// [`SpeechError::AudioCapture`] when another did). It ends at once with
/// [`SpeechError::NotAllowed`] when the app whose engine thread calls does
/// not grant `speech` ([`nsh_core::element::access`]; the session running
/// is left alone then), and with [`SpeechError::Unavailable`] where
/// nothing recognizes speech ([`available`]). Code on no engine's thread
/// is trusted: nothing is checked for it.
pub fn recognize(request: SpeechRequest) -> SpeechRecognition {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (sink, events) = channel();
    let recognition = SpeechRecognition {
        id,
        events,
        ended: false,
    };
    // Refused before anything else: a refused request ends no session.
    if nsh_core::element::access().is_some_and(|access| !access.allows_speech()) {
        log::warn!(
            target: "js",
            "speech recognition is not granted: add `\"speech\": true` to capabilities in nsh.json"
        );
        sink.end(Some(SpeechError::NotAllowed));
        return recognition;
    }
    let owner = nsh_core::element::engine_id();
    // Held while the session starts: one started meanwhile on another
    // engine's thread waits, then replaces this one.
    let mut running = running();
    if let Some(old) = running.take() {
        let error = displaced(&old, owner);
        abort(old, error);
    }
    let control = match backend() {
        Some(backend) => backend.start(request, sink.clone()),
        None if in_terminal() => none::start(request, sink.clone()),
        None => platform::start(request, sink.clone()),
    };
    *running = Some(Running {
        id,
        owner,
        sink,
        control,
    });
    recognition
}

/// What a platform does with a session when its start reaches the
/// recognizer's thread, maybe late (after a permission prompt).
#[cfg(any(target_os = "android", target_os = "macos", target_os = "ios", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Begin {
    /// The module ended it meanwhile (aborted, replaced, its owner gone): a
    /// stale start changes nothing, and the session running keeps running.
    Skip,
    /// The app stopped it before it listened: it ends without an error,
    /// and the session running keeps running.
    End,
    /// It listens: whatever still runs on that thread ends first (the
    /// microphone is one).
    Listen,
}

/// How a platform begins the session of `sink` ([`Begin`]), `stop_asked`
/// when the app stopped it before it listened. Decided before the platform
/// touches the session running.
#[cfg(any(target_os = "android", target_os = "macos", target_os = "ios", test))]
fn begin_as(sink: &SpeechSink, stop_asked: bool) -> Begin {
    if sink.is_ended() {
        Begin::Skip
    } else if stop_asked {
        Begin::End
    } else {
        Begin::Listen
    }
}

/// A running speech recognition session ([`recognize`]). Dropping it
/// before its end aborts it.
#[must_use = "a dropped recognition is aborted"]
pub struct SpeechRecognition {
    id: u64,
    events: SpeechEvents,
    ended: bool,
}

impl std::fmt::Debug for SpeechRecognition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpeechRecognition")
            .field("id", &self.id)
            .field("ended", &self.ended)
            .finish_non_exhaustive()
    }
}

impl SpeechRecognition {
    /// The session's next event; `None` after its end.
    pub async fn next(&mut self) -> Option<SpeechEvent> {
        std::future::poll_fn(|cx| self.poll_next(cx)).await
    }

    /// Polls for the session's next event ([`Self::next`]).
    pub fn poll_next(&mut self, cx: &mut std::task::Context<'_>) -> Poll<Option<SpeechEvent>> {
        let poll = self.events.poll_next(cx);
        if let Poll::Ready(None | Some(SpeechEvent::End { .. })) = poll
            && !self.ended
        {
            self.ended = true;
            // Its recognizer is done: the session no longer runs.
            let mut running = running();
            if running.as_ref().is_some_and(|r| r.id == self.id) {
                *running = None;
            }
        }
        poll
    }

    /// Stops listening: the recognizer finishes what it heard (a last,
    /// final result), then the session ends.
    pub fn stop(&self) {
        if self.ended {
            return;
        }
        let mut running = running();
        if let Some(session) = running.as_mut().filter(|r| r.id == self.id)
            && !session.sink.is_ended()
        {
            session.control.stop();
        }
    }

    /// Ends the session at once, without an error; what was not reported
    /// is dropped.
    pub fn abort(&self) {
        if self.ended {
            return;
        }
        let session = {
            let mut running = running();
            if running.as_ref().is_some_and(|r| r.id == self.id) {
                running.take()
            } else {
                None
            }
        };
        if let Some(session) = session {
            abort(session, None);
        }
    }
}

impl Drop for SpeechRecognition {
    fn drop(&mut self) {
        self.abort();
    }
}

/// Where NSH recognizes no speech: Linux, the terminal host on every OS
/// ([`in_terminal`]) and headless runs (whose sessions the fake recognizer
/// runs when the test installs it, [`FakeSpeech`]).
mod none {
    use super::{SpeechControl, SpeechError, SpeechRequest, SpeechSink};

    pub(super) async fn available() -> bool {
        false
    }

    pub(super) fn start(_: SpeechRequest, events: SpeechSink) -> Box<dyn SpeechControl> {
        events.end(Some(SpeechError::Unavailable));
        Box::new(Ended)
    }

    /// A session that ended as it started.
    struct Ended;

    impl SpeechControl for Ended {
        fn stop(&mut self) {}
        fn abort(&mut self) {}
    }
}

// --- JS ---------------------------------------------------------------------

/// Whether the calling VM may recognize speech: why not when it may not.
fn granted(sys: &System) -> Result<(), JsError> {
    if sys.access.allows_speech() {
        return Ok(());
    }
    Err(JsError::access_denied(
        "speech recognition is not granted: add `\"speech\": true` to capabilities in nsh.json",
        "speech",
        "",
    ))
}

/// Speech recognition. Needs the `speech` capability when the app declares
/// capabilities: without it `start` throws `ERR_ACCESS_DENIED` (checked
/// here, in the call).
#[module]
pub(crate) struct Speech;

#[module]
impl Speech {
    /// Resolves with whether speech can be recognized here: on macOS, iOS,
    /// Android and Windows devices with a recognizer (on Android, a speech
    /// recognition service installed; on Windows, a dictation language and
    /// a microphone), in browsers with the Web Speech API (Chromium-based
    /// browsers and Safari), or where the embedding app gave its own;
    /// `false` elsewhere (Linux, an app in a terminal), where a session ends
    /// at once with `error: "unavailable"`. Whether the user allows the
    /// microphone is asked when a session starts. It tells the platform
    /// only, so it needs no capability.
    pub(crate) async fn available() -> bool {
        crate::speech::available().await
    }

    /// Starts recognizing what the user says and returns the session: its
    /// `start`, `result` and `end` events report it. The system asks the
    /// user for the microphone and speech recognition the first time. One
    /// session runs at a time, in the whole process: starting one ends the
    /// one running, with `end` without an error when this app started it,
    /// and with `error: "audio-capture"` when another app (another
    /// `AppView`) did. Throws `ERR_ACCESS_DENIED` (`permission`
    /// `"speech"`) when the `speech` capability is not granted, a
    /// `TypeError` for options of the wrong type, and a `RangeError` for a
    /// `lang` that is no language tag.
    pub(crate) fn start(
        options: Option<SpeechOptions>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<SpeechSession, JsError> {
        let request = options.unwrap_or_default().request()?;
        granted(&sys)?;
        let state = Rc::new(State::default());
        let cleanup = cx.on_cleanup({
            let state = Rc::downgrade(&state);
            move || {
                if let Some(state) = state.upgrade() {
                    state.abort();
                }
            }
        });
        cx.start(deliver(state.clone(), request, cleanup));
        Ok(SpeechSession { state })
    }
}

/// How `Speech.start` listens.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct SpeechOptions {
    /// The language spoken, a BCP 47 tag (`"en-US"`, `"zh-CN"`); the
    /// user's language when not given.
    lang: Option<String>,
    /// Whether `result` comes while the user speaks, with the transcript
    /// so far (true when not given), or only once, final.
    interim: Option<bool>,
}

impl SpeechOptions {
    /// The request these options make, or why they make none.
    fn request(self) -> Result<SpeechRequest, JsError> {
        let mut request = SpeechRequest::default();
        if let Some(lang) = self.lang {
            let tag = !lang.is_empty()
                && lang.len() <= 35
                && lang.split(['-', '_']).all(|part| {
                    !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric())
                });
            if !tag {
                return Err(JsError::Range(format!(
                    "`lang` must be a language tag such as \"en-US\", not {lang:?}"
                )));
            }
            request.lang = Some(lang);
        }
        if let Some(interim) = self.interim {
            request.interim = interim;
        }
        Ok(request)
    }
}

/// A session's events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum SpeechSessionEvent {
    Start,
    Result,
    End,
}

/// The event the recognizer starts listening with (`on`'s first overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum SpeechStartEvent {
    Start,
}

/// The event the transcript comes with (`on`'s second overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum SpeechResultEvent {
    Result,
}

/// The event a session ends with (`on`'s third overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum SpeechEndEvent {
    End,
}

/// Why a session failed (the `end` event's `error`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum SpeechErrorCode {
    /// The user, the system or the app's capabilities do not allow the
    /// microphone or speech recognition.
    #[prop(rename = "not-allowed")]
    NotAllowed,
    /// Nothing was said.
    #[prop(rename = "no-speech")]
    NoSpeech,
    /// The microphone could not be used.
    #[prop(rename = "audio-capture")]
    AudioCapture,
    /// The recognizer needs the network and could not reach it.
    #[prop(rename = "network")]
    Network,
    /// The recognizer does not know the language asked for.
    #[prop(rename = "language-not-supported")]
    LanguageNotSupported,
    /// The platform recognizes no speech, or not now.
    #[prop(rename = "unavailable")]
    Unavailable,
    /// The recognizer failed for another reason.
    #[prop(rename = "failed")]
    Failed,
}

impl From<SpeechError> for SpeechErrorCode {
    fn from(error: SpeechError) -> Self {
        match error {
            SpeechError::NotAllowed => Self::NotAllowed,
            SpeechError::NoSpeech => Self::NoSpeech,
            SpeechError::AudioCapture => Self::AudioCapture,
            SpeechError::Network => Self::Network,
            SpeechError::LanguageNotSupported => Self::LanguageNotSupported,
            SpeechError::Unavailable => Self::Unavailable,
            SpeechError::Failed => Self::Failed,
        }
    }
}

/// The transcript so far (the `result` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct SpeechResult {
    /// The whole transcript of the session so far.
    text: String,
    /// The recognizer will not change it any more.
    is_final: bool,
}

/// How a session ended (the `end` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct SpeechEnd {
    /// The transcript of the session (`""` when nothing was recognized).
    text: String,
    /// Why it failed; absent when it did not (stopped, aborted, finished).
    #[prop(skip_none)]
    error: Option<SpeechErrorCode>,
}

/// What a listener gets.
#[derive(Debug, Clone)]
pub(crate) enum Payload {
    Start,
    Result(SpeechResult),
    End(SpeechEnd),
}

impl JsValue for Payload {
    fn ts_type(types: &mut TsTypes) -> String {
        format!(
            "{} | {}",
            <SpeechResult as JsValue>::ts_type(types),
            <SpeechEnd as JsValue>::ts_type(types)
        )
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("no value (a payload goes to JS only)"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Payload::Start => Ret::into_js((), host),
            Payload::Result(result) => result.to_js(host),
            Payload::End(end) => end.to_js(host),
        }
    }
}

/// Listeners per event of one session, at most.
const MAX_LISTENERS: usize = 64;

/// A session's listeners with their ids, by [`SpeechSessionEvent`].
type Listeners = [Vec<(u32, Callback<Payload>)>; 3];

/// One session as its object and its task see it.
#[derive(Default)]
struct State {
    /// `start`, `result` and `end` listeners with their ids, released at
    /// the end.
    listeners: RefCell<Listeners>,
    next_listener: Cell<u32>,
    /// The session, once the task started it; `None` again at the end.
    recognition: RefCell<Option<SpeechRecognition>>,
    /// `stop()` came before the task started the session.
    stop_asked: Cell<bool>,
    /// The transcript so far.
    text: RefCell<String>,
    /// How it ended, once it has.
    ended: RefCell<Option<SpeechEnd>>,
}

impl State {
    fn post(&self, event: SpeechSessionEvent, payload: Payload) {
        for (_, listener) in &self.listeners.borrow()[event as usize] {
            listener.post(payload.clone());
        }
    }

    /// Ends the session: the `end` listeners get `end`, then every
    /// listener goes.
    fn finish(&self, error: Option<SpeechError>) {
        if self.ended.borrow().is_some() {
            return;
        }
        let end = SpeechEnd {
            text: self.text.borrow().clone(),
            error: error.map(SpeechErrorCode::from),
        };
        *self.ended.borrow_mut() = Some(end.clone());
        // Taken out first: dropping it aborts nothing once it ended.
        let recognition = self.recognition.borrow_mut().take();
        drop(recognition);
        let listeners = std::mem::take(&mut *self.listeners.borrow_mut());
        for (_, listener) in &listeners[SpeechSessionEvent::End as usize] {
            listener.post(Payload::End(end.clone()));
        }
    }

    fn stop(&self) {
        if self.ended.borrow().is_some() {
            return;
        }
        match &*self.recognition.borrow() {
            Some(recognition) => recognition.stop(),
            None => self.stop_asked.set(true),
        }
    }

    fn abort(&self) {
        if self.ended.borrow().is_some() {
            return;
        }
        if let Some(recognition) = &*self.recognition.borrow() {
            recognition.abort();
        }
        // At once, without waiting for the recognizer: nothing comes after.
        self.finish(None);
    }
}

/// Starts the session and posts its events to the listeners until it ends.
/// In a task: the engine's capabilities are read there
/// ([`nsh_core::element::access`]).
async fn deliver(state: Rc<State>, request: SpeechRequest, cleanup: Cleanup) {
    if state.ended.borrow().is_none() {
        let recognition = recognize(request);
        if state.stop_asked.get() {
            recognition.stop();
        }
        *state.recognition.borrow_mut() = Some(recognition);
        loop {
            let event = std::future::poll_fn(|cx| match &mut *state.recognition.borrow_mut() {
                Some(recognition) => recognition.poll_next(cx),
                None => Poll::Ready(None),
            })
            .await;
            match event {
                Some(SpeechEvent::Start) => state.post(SpeechSessionEvent::Start, Payload::Start),
                Some(SpeechEvent::Result { text, is_final }) => {
                    *state.text.borrow_mut() = text.clone();
                    state.post(
                        SpeechSessionEvent::Result,
                        Payload::Result(SpeechResult { text, is_final }),
                    );
                }
                Some(SpeechEvent::End { error }) => {
                    state.finish(error);
                    break;
                }
                // Aborted here (`abort()`, the owner went).
                None => break,
            }
        }
    }
    // An owner that lives long must not collect one cleanup per session.
    cleanup.release();
}

/// A speech recognition session `Speech.start` started.
#[class]
pub(crate) struct SpeechSession {
    state: Rc<State>,
}

#[class]
impl SpeechSession {
    /// Calls `listener` in JS's next turn: `start` once the microphone is
    /// on and the recognizer listens; `result` with the whole transcript so
    /// far each time it changes (`isFinal` on the last one of a session
    /// that ends normally); `end` once, last, with the transcript and, when
    /// it failed, the `error` (`not-allowed`, `no-speech`, `audio-capture`,
    /// `network`, `language-not-supported`, `unavailable`, `failed`). An
    /// `end` listener added after the end gets it too. Returns a function
    /// that stops it; it also stops when what called `on` goes (a
    /// component), and every listener goes with the end.
    #[overload(fn(event: SpeechStartEvent, listener: Callback<()>) -> Stop)]
    #[overload(fn(event: SpeechResultEvent, #[args(result)] listener: Callback<SpeechResult>) -> Stop)]
    #[overload(fn(event: SpeechEndEvent, #[args(end)] listener: Callback<SpeechEnd>) -> Stop)]
    pub(crate) fn on(
        &self,
        event: SpeechSessionEvent,
        #[args(payload)] listener: Callback<Payload>,
    ) -> Result<Stop, JsError> {
        let ended = self.state.ended.borrow().clone();
        if let Some(end) = ended {
            if event == SpeechSessionEvent::End {
                listener.post(Payload::End(end));
            }
            return Ok(Stop::new(|| {}));
        }
        let id = self.state.next_listener.get();
        self.state.next_listener.set(id.wrapping_add(1));
        let mut listeners = self.state.listeners.borrow_mut();
        let list = &mut listeners[event as usize];
        if list.len() >= MAX_LISTENERS {
            return Err(JsError::Error(format!(
                "a speech session takes at most {MAX_LISTENERS} listeners per event"
            ))
            .with_code(codes::QUOTA_EXCEEDED));
        }
        list.push((id, listener));
        let state: Weak<State> = Rc::downgrade(&self.state);
        Ok(Stop::new(move || {
            if let Some(state) = state.upgrade() {
                state.listeners.borrow_mut()[event as usize].retain(|(i, _)| *i != id);
            }
        }))
    }

    /// The transcript so far (`""` before the first result).
    #[getter]
    pub(crate) fn text(&self) -> String {
        self.state.text.borrow().clone()
    }

    /// Whether the session ended (its `end` came or is coming).
    #[getter]
    pub(crate) fn ended(&self) -> bool {
        self.state.ended.borrow().is_some()
    }

    /// Stops listening: the recognizer finishes what it heard, then the
    /// session ends (a last, final `result`, then `end`). Nothing once it
    /// ended.
    pub(crate) fn stop(&self) {
        self.state.stop();
    }

    /// Ends the session at once, without an error: `end` comes next with
    /// the transcript so far, and what was not recognized yet is dropped.
    /// Nothing once it ended.
    pub(crate) fn abort(&self) {
        self.state.abort();
    }
}

#[cfg(test)]
mod tests;
