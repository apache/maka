//! `nsh`'s `Sound` and `AudioPlayer` ([`crate::audio`],
//! `docs/dev/audio-design.md`): short sounds decoded into memory and played
//! any number of times, and long audio streamed by a player. Needs the
//! `audio` capability when the app declares capabilities: without it
//! `Sound.load` rejects and `new AudioPlayer` throws `ERR_ACCESS_DENIED`
//! (checked here, in the call; the core also refuses Rust components'
//! sounds and players, which fail with `not-allowed`).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    task::{Poll, Waker},
    time::Duration,
};

use crate::{
    audio::{AudioError, AudioEvent, PlayerSettings, check_rate, check_volume},
    element::{
        AudioFailure, CallCx, Callback, Cleanup, JsError, JsHost, JsIn, JsObject, JsOwned, JsValue,
        Later, PropEnum, PropError, Ret, Stop, System, TsTypes, class, codes,
    },
};

/// The error a failure rejects or reports with: its `code` the
/// runtime's (`ERR_ACCESS_DENIED`, `ERR_NSH_QUOTA_EXCEEDED`,
/// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`) where it has one, else an
/// `Error` with the audio error's name as `code`.
fn thrown(failure: AudioFailure, src: &str) -> JsError {
    match failure.error {
        AudioError::NotAllowed => {
            let permission = if failure.message.contains("network") {
                "network"
            } else {
                "audio"
            };
            JsError::access_denied(failure.message, permission, src)
        }
        AudioError::QuotaExceeded => {
            JsError::Error(failure.message).with_code(codes::QUOTA_EXCEEDED)
        }
        AudioError::Unavailable => JsError::Error(failure.message).with_code(codes::UNAVAILABLE),
        error => JsError::Error(failure.message).with_code(error.as_str()),
    }
}

/// Whether the app may make sound and load `src`: why not when it may not.
fn granted(sys: &System, src: &str) -> Result<(), JsError> {
    if !sys.access.allows_audio() {
        return Err(JsError::access_denied(
            "sound is not granted: add `\"audio\": true` to capabilities in nsh.json",
            "audio",
            src,
        ));
    }
    let remote = src.starts_with("http://") || src.starts_with("https://");
    if remote && !sys.access.allows_media(src) {
        return Err(JsError::access_denied(
            format!("`{src}` is not granted by capabilities.network in nsh.json"),
            "network",
            src,
        ));
    }
    Ok(())
}

/// A volume from JS, checked.
fn volume(value: Option<f64>) -> Result<f32, JsError> {
    value.map_or(Ok(1.0), |v| check_volume(v as f32).map_err(JsError::Range))
}

/// A rate from JS, checked.
fn rate(value: Option<f64>) -> Result<f32, JsError> {
    value.map_or(Ok(1.0), |v| check_rate(v as f32).map_err(JsError::Range))
}

/// A short sound decoded into memory, played any number of times,
/// overlapping: feedback, alerts, notices. Load it ahead with
/// `Sound.load`, then `play()` starts at once. Sounds are at most 5 s
/// long and 8 MB encoded; longer audio is an `AudioPlayer`'s. Freed by
/// `dispose()`, or when what loaded it goes (a component).
#[class]
pub(crate) struct Sound {
    /// The loaded sound; `None` once what loaded it went.
    sound: Rc<RefCell<Option<crate::element::Sound>>>,
}

#[class]
impl Sound {
    /// Resolves with whether sound plays here: `false` where nothing plays
    /// it, and `load` then rejects with
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
    pub(crate) fn available() -> Later<bool> {
        Later::new(async { Ok::<_, JsError>(crate::element::audio_available().await) })
    }

    /// Loads the sound at `src` (a bundled asset's path, `file:`, `data:`,
    /// or an `http(s)` URL `network` grants) and decodes it into memory.
    /// Loading a source loaded already shares it. Rejects with
    /// `ERR_ACCESS_DENIED` when the `audio` capability (or `network`, for a
    /// remote source) is not granted, `ERR_NSH_QUOTA_EXCEEDED` past a
    /// limit (8 MB encoded, 5 s long, 64 sounds, 16 MB decoded in all),
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where nothing plays sound, and
    /// an `Error` with `code` `"network"`, `"decode"` or `"not-supported"`
    /// when it cannot be read or decoded.
    pub(crate) fn load(src: String, sys: System, cx: CallCx<'_>) -> Later<Sound> {
        let checked = granted(&sys, &src);
        let slot: Rc<RefCell<Option<crate::element::Sound>>> = Rc::default();
        // What loaded it goes: the sound goes with it.
        let cleanup = cx.on_cleanup({
            let slot = Rc::downgrade(&slot);
            move || {
                if let Some(slot) = slot.upgrade() {
                    slot.borrow_mut().take();
                }
            }
        });
        Later::new(async move {
            checked?;
            match crate::element::load_sound(&src).await {
                Ok(sound) => {
                    *slot.borrow_mut() = Some(sound);
                    // Kept: the owner frees it.
                    drop(cleanup);
                    Ok(Sound { sound: slot })
                }
                Err(failure) => {
                    cleanup.release();
                    Err(thrown(failure, &src))
                }
            }
        })
    }

    /// Plays the sound over what plays, at `volume` (0 to 1, 1 when not
    /// given) and `rate` (0.5 to 2, 1 when not given; the pitch goes with
    /// it). Throws a `RangeError` for a value out of range; a muted device
    /// is silence, not an error. Nothing once it was freed.
    pub(crate) fn play(&self, options: Option<PlayOptions>) -> Result<(), JsError> {
        let options = options.unwrap_or_default();
        let volume = volume(options.volume)?;
        let rate = rate(options.rate)?;
        if let Some(sound) = &*self.sound.borrow() {
            sound.play(volume, rate);
        }
        Ok(())
    }

    /// Stops every play of the sound.
    pub(crate) fn stop(&self) {
        if let Some(sound) = &*self.sound.borrow() {
            sound.stop();
        }
    }

    /// How long it plays, in seconds (0 once freed).
    #[getter]
    pub(crate) fn duration(&self) -> f64 {
        self.sound
            .borrow()
            .as_ref()
            .map_or(0.0, |s| s.duration().as_secs_f64())
    }
}

/// How `Sound.play` plays.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct PlayOptions {
    /// From 0 (silent) to 1 (as recorded, when not given).
    volume: Option<f64>,
    /// From 0.5 to 2 (1 when not given); the pitch goes with it.
    rate: Option<f64>,
}

/// How an `AudioPlayer` plays.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct AudioPlayerOptions {
    /// From 0 (silent) to 1 (as recorded, when not given).
    volume: Option<f64>,
    /// From 0.5 to 2 (1 when not given); the pitch is kept where the
    /// platform can.
    rate: Option<f64>,
    /// Starts again at its end, without `end` (false when not given).
    r#loop: Option<bool>,
}

/// Where a player is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum AudioPlayerState {
    /// Nothing asked yet, or failed (`error` said why).
    Idle,
    /// Loading its source, or waiting for data.
    Loading,
    /// Playing.
    Playing,
    /// Paused.
    Paused,
    /// Played to its end.
    Ended,
}

/// A player's events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum AudioPlayerEvent {
    Load,
    Progress,
    Buffer,
    End,
    Error,
}

/// The event a player knows its duration with (`on`'s first overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum AudioLoadEvent {
    Load,
}

/// The event a player reports where it is with (`on`'s second overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum AudioProgressEvent {
    Progress,
}

/// The event a player waits for data with (`on`'s third overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum AudioBufferEvent {
    Buffer,
}

/// The event a player ends with (`on`'s fourth overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum AudioEndEvent {
    End,
}

/// The event a player fails with (`on`'s fifth overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum AudioErrorEvent {
    Error,
}

/// A player knows its duration (the `load` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct AudioLoad {
    /// In seconds; `Infinity` for a live stream.
    duration: f64,
}

/// Where a player is (the `progress` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct AudioProgress {
    /// Its position, in seconds.
    current_time: f64,
    /// Its duration, in seconds (`NaN` while unknown, `Infinity` live).
    duration: f64,
}

/// A player waits for data, or stopped waiting (the `buffer` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct AudioBuffering {
    /// It waits.
    buffering: bool,
}

/// Why a player failed (the `error` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct AudioErrorInfo {
    /// `"not-allowed"`, `"network"`, `"decode"`, `"not-supported"`,
    /// `"quota-exceeded"`, `"unavailable"` or `"failed"`.
    code: String,
    /// What happened, in words.
    message: String,
}

/// What a listener gets.
#[derive(Debug, Clone)]
pub(crate) enum Payload {
    Load(AudioLoad),
    Progress(AudioProgress),
    Buffer(AudioBuffering),
    End,
    Error(AudioErrorInfo),
}

impl JsValue for Payload {
    fn ts_type(types: &mut TsTypes) -> String {
        format!(
            "{} | {} | {} | {}",
            <AudioLoad as JsValue>::ts_type(types),
            <AudioProgress as JsValue>::ts_type(types),
            <AudioBuffering as JsValue>::ts_type(types),
            <AudioErrorInfo as JsValue>::ts_type(types)
        )
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("no value (a payload goes to JS only)"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Payload::Load(load) => load.to_js(host),
            Payload::Progress(progress) => progress.to_js(host),
            Payload::Buffer(buffer) => buffer.to_js(host),
            Payload::End => Ret::into_js((), host),
            Payload::Error(error) => error.to_js(host),
        }
    }
}

/// Listeners per event of one player, at most.
const MAX_LISTENERS: usize = 64;

/// A player's listeners with their ids, by [`AudioPlayerEvent`].
type Listeners = [Vec<(u32, Callback<Payload>)>; 5];

/// What a call made before the task opened the player asks of it.
#[derive(Debug, Clone, Copy)]
enum Queued {
    Play,
    Preload,
    Pause,
    Seek(Duration),
}

/// A `play()` waiting for the player to play.
type PlayWait = Rc<RefCell<(Option<Result<(), JsError>>, Option<Waker>)>>;

/// One player as its object and its task see it.
#[derive(Default)]
struct State {
    src: String,
    listeners: RefCell<Listeners>,
    next_listener: Cell<u32>,
    /// The core's player, once the task opened it; `None` again when it
    /// closed.
    player: RefCell<Option<crate::element::AudioPlayer>>,
    /// What came before the task opened it.
    queued: RefCell<Vec<Queued>>,
    settings: Cell<PlayerSettings>,
    /// The volume and rate as the app gave them (the settings hold `f32`s,
    /// which would read back as `0.800000011920929`).
    given: Cell<(f64, f64)>,
    state: Cell<Option<AudioPlayerState>>,
    position: Cell<Duration>,
    /// `None` while unknown, `Some(None)` a live stream.
    duration: Cell<Option<Option<Duration>>>,
    plays: RefCell<Vec<PlayWait>>,
    /// The platform said it plays, and has not paused, ended or failed.
    playing: Cell<bool>,
    closed: Cell<bool>,
}

impl State {
    fn post(&self, event: AudioPlayerEvent, payload: Payload) {
        for (_, listener) in &self.listeners.borrow()[event as usize] {
            listener.post(payload.clone());
        }
    }

    fn state(&self) -> AudioPlayerState {
        self.state.get().unwrap_or(AudioPlayerState::Idle)
    }

    fn act(&self, queued: Queued) {
        if self.closed.get() {
            return;
        }
        match &*self.player.borrow() {
            Some(player) => match queued {
                Queued::Play => player.play(),
                Queued::Preload => player.preload(),
                Queued::Pause => player.pause(),
                Queued::Seek(position) => player.seek(position),
            },
            None => self.queued.borrow_mut().push(queued),
        }
    }

    fn set(&self, settings: PlayerSettings) {
        self.settings.set(settings);
        if let Some(player) = &*self.player.borrow() {
            player.set_settings(settings);
        }
    }

    fn settle(&self, result: Result<(), JsError>) {
        for wait in self.plays.take() {
            let waker = {
                let mut wait = wait.borrow_mut();
                wait.0 = Some(result.clone());
                wait.1.take()
            };
            if let Some(waker) = waker {
                waker.wake();
            }
        }
    }

    /// Stops and frees the player; its listeners go, and `play()`s waiting
    /// reject.
    fn close(&self) {
        if self.closed.replace(true) {
            return;
        }
        let player = self.player.borrow_mut().take();
        drop(player);
        self.listeners.take();
        self.state.set(Some(AudioPlayerState::Idle));
        self.settle(Err(JsError::Error("the player was closed".into())));
    }

    fn seconds(duration: Option<Option<Duration>>) -> f64 {
        match duration {
            None => f64::NAN,
            Some(None) => f64::INFINITY,
            Some(Some(d)) => d.as_secs_f64(),
        }
    }
}

/// Opens the core's player and follows its events until it closes.
async fn run(state: Rc<State>, cleanup: Cleanup) {
    if !state.closed.get() {
        let player = crate::element::audio_player(&state.src, state.settings.get());
        *state.player.borrow_mut() = Some(player);
        for queued in state.queued.take() {
            state.act(queued);
        }
        loop {
            let event = std::future::poll_fn(|cx| match &mut *state.player.borrow_mut() {
                Some(player) => player.poll_next(cx),
                None => Poll::Ready(None),
            })
            .await;
            let Some(event) = event else { break };
            match event {
                AudioEvent::Load { duration } => {
                    state.duration.set(Some(duration));
                    state.post(
                        AudioPlayerEvent::Load,
                        Payload::Load(AudioLoad {
                            duration: State::seconds(Some(duration)),
                        }),
                    );
                }
                AudioEvent::Playing => {
                    state.playing.set(true);
                    state.state.set(Some(AudioPlayerState::Playing));
                    state.settle(Ok(()));
                }
                AudioEvent::Paused => {
                    state.playing.set(false);
                    state.state.set(Some(AudioPlayerState::Paused));
                }
                AudioEvent::Progress { position, duration } => {
                    state.position.set(position);
                    if duration.is_some() {
                        state.duration.set(Some(duration));
                    }
                    state.post(
                        AudioPlayerEvent::Progress,
                        Payload::Progress(AudioProgress {
                            current_time: position.as_secs_f64(),
                            duration: State::seconds(state.duration.get()),
                        }),
                    );
                }
                AudioEvent::Buffer { buffering } => {
                    // Waiting for data while playing is loading; playing
                    // again once it came.
                    match (buffering, state.state()) {
                        (true, AudioPlayerState::Playing) => {
                            state.state.set(Some(AudioPlayerState::Loading));
                        }
                        (false, AudioPlayerState::Loading) if state.playing.get() => {
                            state.state.set(Some(AudioPlayerState::Playing));
                        }
                        _ => {}
                    }
                    state.post(
                        AudioPlayerEvent::Buffer,
                        Payload::Buffer(AudioBuffering { buffering }),
                    );
                }
                AudioEvent::Ended => {
                    state.playing.set(false);
                    state.state.set(Some(AudioPlayerState::Ended));
                    if let Some(Some(duration)) = state.duration.get() {
                        state.position.set(duration);
                    }
                    state.post(AudioPlayerEvent::End, Payload::End);
                }
                AudioEvent::Failed { error, message } => {
                    state.playing.set(false);
                    state.state.set(Some(AudioPlayerState::Idle));
                    state.settle(Err(thrown(
                        AudioFailure {
                            error,
                            message: message.clone(),
                        },
                        &state.src,
                    )));
                    state.post(
                        AudioPlayerEvent::Error,
                        Payload::Error(AudioErrorInfo {
                            code: error.as_str().into(),
                            message,
                        }),
                    );
                }
                _ => {}
            }
        }
    }
    // An owner that lives long must not collect one cleanup per player.
    cleanup.release();
}

/// A player of long audio, streamed from its source as it plays: music,
/// voice messages, recordings. Nothing loads until `play()` or
/// `preload()`. Stops and frees what plays it with `dispose()`, or when
/// what made it goes (a component): keep it while it plays.
#[class]
pub(crate) struct AudioPlayer {
    state: Rc<State>,
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        self.state.close();
    }
}

#[class]
impl AudioPlayer {
    /// A player of `src` (a bundled asset's path, `file:`, or an `http(s)`
    /// URL `network` grants). Throws `ERR_ACCESS_DENIED` when the `audio`
    /// capability (or `network`, for a remote source) is not granted, a
    /// `RangeError` for a volume or rate out of range.
    pub(crate) fn new(
        src: String,
        options: Option<AudioPlayerOptions>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<Self, JsError> {
        let options = options.unwrap_or_default();
        let settings = PlayerSettings {
            volume: volume(options.volume)?,
            rate: rate(options.rate)?,
            looped: options.r#loop.unwrap_or(false),
        };
        granted(&sys, &src)?;
        let state = Rc::new(State {
            src,
            settings: Cell::new(settings),
            given: Cell::new((options.volume.unwrap_or(1.0), options.rate.unwrap_or(1.0))),
            ..State::default()
        });
        let cleanup = cx.on_cleanup({
            let state = Rc::downgrade(&state);
            move || {
                if let Some(state) = state.upgrade() {
                    state.close();
                }
            }
        });
        cx.start(run(state.clone(), cleanup));
        Ok(AudioPlayer { state })
    }

    /// Resolves with whether sound plays here (`Sound.available()`).
    pub(crate) fn available() -> Later<bool> {
        Later::new(async { Ok::<_, JsError>(crate::element::audio_available().await) })
    }

    /// Calls `listener` in JS's next turn: `load` once it knows its
    /// duration; `progress` about 4 times a second while it plays, and
    /// after a seek; `buffer` when it starts or stops waiting for data;
    /// `end` when it played to its end (never while it loops); `error`
    /// when it failed, with a `code` (`not-allowed`, `network`, `decode`,
    /// `not-supported`, `unavailable`, `failed`). Returns a function that
    /// stops it; it also stops when what called `on` goes (a component).
    #[overload(fn(event: AudioLoadEvent, #[args(load)] listener: Callback<AudioLoad>) -> Stop)]
    #[overload(fn(event: AudioProgressEvent, #[args(progress)] listener: Callback<AudioProgress>) -> Stop)]
    #[overload(fn(event: AudioBufferEvent, #[args(buffer)] listener: Callback<AudioBuffering>) -> Stop)]
    #[overload(fn(event: AudioEndEvent, listener: Callback<()>) -> Stop)]
    #[overload(fn(event: AudioErrorEvent, #[args(error)] listener: Callback<AudioErrorInfo>) -> Stop)]
    pub(crate) fn on(
        &self,
        event: AudioPlayerEvent,
        #[args(payload)] listener: Callback<Payload>,
    ) -> Result<Stop, JsError> {
        if self.state.closed.get() {
            return Ok(Stop::new(|| {}));
        }
        let id = self.state.next_listener.get();
        self.state.next_listener.set(id.wrapping_add(1));
        let mut listeners = self.state.listeners.borrow_mut();
        let list = &mut listeners[event as usize];
        if list.len() >= MAX_LISTENERS {
            return Err(JsError::Error(format!(
                "a player takes at most {MAX_LISTENERS} listeners per event"
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

    /// Plays from where it is, loading first if needed; resolves once it
    /// plays. Rejects as `error` reports when it fails (on the web, with
    /// `code` `"not-allowed"` before the user's first gesture), and when
    /// the player is disposed first.
    pub(crate) fn play(&self) -> Later<()> {
        let wait: PlayWait = Rc::default();
        if self.state.closed.get() {
            wait.borrow_mut().0 = Some(Err(JsError::Error("the player was closed".into())));
        } else {
            if self.state.state() != AudioPlayerState::Playing {
                self.state.state.set(Some(AudioPlayerState::Loading));
            }
            self.state.plays.borrow_mut().push(wait.clone());
            self.state.act(Queued::Play);
        }
        Later::new(std::future::poll_fn(move |cx| {
            let mut wait = wait.borrow_mut();
            match wait.0.take() {
                Some(result) => Poll::Ready(result),
                None => {
                    wait.1 = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        }))
    }

    /// Starts loading without playing, so the first `play()` starts at
    /// once.
    pub(crate) fn preload(&self) {
        self.state.act(Queued::Preload);
    }

    /// Pauses.
    pub(crate) fn pause(&self) {
        self.state.act(Queued::Pause);
    }

    /// Moves to `seconds` (past the end: the end). Throws a `RangeError`
    /// for a negative, non-finite or unrepresentable time.
    pub(crate) fn seek(&self, seconds: f64) -> Result<(), JsError> {
        // `try_`: a finite time can still be too large for a `Duration`
        // (`seek(1e30)`), which `from_secs_f64` panics on.
        let Ok(position) = Duration::try_from_secs_f64(seconds) else {
            return Err(JsError::Range(format!(
                "`seek` takes a time of 0 seconds or more, not {seconds}"
            )));
        };
        self.state.position.set(position);
        self.state.act(Queued::Seek(position));
        Ok(())
    }

    /// Its volume, from 0 (silent) to 1 (as recorded). Setting it out of
    /// range throws a `RangeError`.
    #[getter]
    pub(crate) fn volume(&self) -> f64 {
        self.state.given.get().0
    }

    #[setter]
    pub(crate) fn set_volume(&self, value: f64) -> Result<(), JsError> {
        let settings = PlayerSettings {
            volume: volume(Some(value))?,
            ..self.state.settings.get()
        };
        self.state.given.set((value, self.state.given.get().1));
        self.state.set(settings);
        Ok(())
    }

    /// Its rate, from 0.5 to 2 (the pitch kept where the platform can).
    /// Setting it out of range throws a `RangeError`.
    #[getter]
    pub(crate) fn rate(&self) -> f64 {
        self.state.given.get().1
    }

    #[setter]
    pub(crate) fn set_rate(&self, value: f64) -> Result<(), JsError> {
        let settings = PlayerSettings {
            rate: rate(Some(value))?,
            ..self.state.settings.get()
        };
        self.state.given.set((self.state.given.get().0, value));
        self.state.set(settings);
        Ok(())
    }

    /// Whether it starts again at its end (without `end`).
    #[getter]
    pub(crate) fn r#loop(&self) -> bool {
        self.state.settings.get().looped
    }

    #[setter]
    pub(crate) fn set_loop(&self, value: bool) {
        let settings = PlayerSettings {
            looped: value,
            ..self.state.settings.get()
        };
        self.state.set(settings);
    }

    /// Its position, in seconds (the last `progress`'s, or a seek's).
    #[getter]
    pub(crate) fn current_time(&self) -> f64 {
        self.state.position.get().as_secs_f64()
    }

    /// Its duration, in seconds: `NaN` until `load`, `Infinity` for a live
    /// stream.
    #[getter]
    pub(crate) fn duration(&self) -> f64 {
        State::seconds(self.state.duration.get())
    }

    /// `"idle"`, `"loading"`, `"playing"`, `"paused"` or `"ended"`.
    #[getter]
    pub(crate) fn state(&self) -> AudioPlayerState {
        self.state.state()
    }
}
