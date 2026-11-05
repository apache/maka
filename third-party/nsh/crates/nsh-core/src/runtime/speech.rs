//! `nsh`'s `Speech`: speech recognition (dictation). The user speaks, the
//! app gets the transcript as it grows ([`crate::speech`]): the Speech
//! framework fed by the microphone on macOS and iOS, an embedding app's
//! recognizer where it gave one. Needs the `speech` capability when the
//! app declares capabilities: without it `start` throws `ERR_ACCESS_DENIED`
//! (checked here, in the call; the core also refuses the sessions of Rust
//! components, which then end with `not-allowed`).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    task::Poll,
};

use crate::{
    element::{
        CallCx, Callback, Cleanup, JsError, JsHost, JsIn, JsObject, JsOwned, JsValue, Later,
        PropEnum, PropError, Ret, SpeechRecognition, Stop, System, TsTypes, class, codes, module,
    },
    speech::{SpeechError, SpeechEvent, SpeechRequest},
};

/// Speech recognition.
#[module]
pub(crate) struct Speech;

#[module]
impl Speech {
    /// Resolves with whether speech can be recognized here: on macOS and
    /// iOS (the system's recognizer), or where the embedding app gave its
    /// own; `false` on the other platforms, where a session ends at once
    /// with `error: "unavailable"`. Whether the user allows the microphone
    /// is asked when a session starts.
    pub(crate) fn available() -> Later<bool> {
        Later::new(async { Ok::<_, JsError>(crate::prelude::speech_available().await) })
    }

    /// Starts recognizing what the user says and returns the session: its
    /// `start`, `result` and `end` events report it. The system asks the
    /// user for the microphone and speech recognition the first time. One
    /// session runs at a time: starting one ends the one running (its
    /// `end`, without an error). Throws `ERR_ACCESS_DENIED` (`permission`
    /// `"speech"`) when the `speech` capability is not granted, a
    /// `TypeError` for options of the wrong type, and a `RangeError` for a
    /// `lang` that is no language tag.
    pub(crate) fn start(
        options: Option<SpeechOptions>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<SpeechSession, JsError> {
        let request = options.unwrap_or_default().request()?;
        if !sys.access.allows_speech() {
            return Err(JsError::access_denied(
                "speech recognition is not granted: add `\"speech\": true` to capabilities in \
                 nsh.json",
                "speech",
                "",
            ));
        }
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
            _ => Self::Failed,
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
    /// The core's session, once the task started it; `None` again at the
    /// end.
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
        // At once, without waiting for the core: nothing comes after.
        self.finish(None);
    }
}

/// Starts the core's session and posts its events to the listeners until
/// it ends.
async fn deliver(state: Rc<State>, request: SpeechRequest, cleanup: Cleanup) {
    if state.ended.borrow().is_none() {
        let recognition = crate::prelude::recognize_speech(request);
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
