//! Speech recognition on the web: the browser's Web Speech API
//! (`SpeechRecognition`, `webkitSpeechRecognition` in Chromium and
//! Safari), reached through wasm-bindgen, as any crate of an app reaches
//! the browser. It talks to the browser directly, also when the page that
//! runs the app answers `nsh/host`.
//!
//! A session is one continuous recognition: interim results when the
//! request asks for them, the language as `lang`. Its results make the
//! whole transcript; the browser's error names are [`SpeechError`]'s.
//! Stopping it is `stop()` (the browser finishes what it heard), aborting
//! it `abort()`. The browser asks the user for the microphone when a
//! session starts. Without the API (Firefox) [`available`] is false and a
//! session ends with `unavailable`.
//!
//! The part that needs no browser (error names, the transcript) builds on
//! every target, for the module's tests.

use super::SpeechError;

/// The transcript of a session: its results' best transcripts, in order.
/// Each result after the first carries the space before it where the
/// language has spaces.
pub(super) fn transcript<S: AsRef<str>>(results: impl IntoIterator<Item = S>) -> String {
    let mut text = String::new();
    for result in results {
        text.push_str(result.as_ref());
    }
    text.trim().to_owned()
}

/// What the browser's error `code` means to the app; `None` for the end of
/// a stop (`stopping`) that `heard` something, and for `aborted`: the
/// session the app aborted already ended, and one the page aborted ends
/// without an error.
pub(super) fn speech_error(code: &str, stopping: bool, heard: bool) -> Option<SpeechError> {
    match code {
        "aborted" => None,
        "no-speech" if stopping && heard => None,
        // The service refused the request (Safari without Siri, a policy).
        "service-not-allowed" => Some(SpeechError::NotAllowed),
        _ => match SpeechError::from_name(code) {
            Some(error) => Some(error),
            None if stopping => None,
            // `bad-grammar`, and names browsers add.
            None => Some(SpeechError::Failed),
        },
    }
}

#[cfg(target_arch = "wasm32")]
pub(super) use self::browser::{available, start};

#[cfg(target_arch = "wasm32")]
mod browser {
    use std::{
        cell::RefCell,
        sync::atomic::{AtomicU64, Ordering},
    };

    use wasm_bindgen::{JsCast, JsValue, closure::Closure};
    use web_sys::{Event, SpeechRecognition, SpeechRecognitionEvent};

    use super::{
        super::{SpeechControl, SpeechError, SpeechRequest, SpeechSink},
        speech_error, transcript,
    };

    thread_local! {
        /// The session running. The page has one thread: the module's
        /// calls and the browser's events all come on it.
        static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    }

    type Handler = Closure<dyn FnMut(Event)>;

    /// The session running.
    struct Session {
        id: u64,
        sink: SpeechSink,
        interim: bool,
        recognition: SpeechRecognition,
        /// The recognition's `start`, `result`, `error` and `end` handlers,
        /// alive as long as the session.
        _handlers: [Handler; 4],
        /// `stop()` came: the browser finishes what it heard.
        stopping: bool,
        /// The transcript so far.
        text: String,
    }

    /// The browser's recognizer class, if it has one.
    fn constructor() -> Option<js_sys::Function> {
        let global = js_sys::global();
        ["SpeechRecognition", "webkitSpeechRecognition"]
            .into_iter()
            .find_map(|name| {
                js_sys::Reflect::get(&global, &JsValue::from_str(name))
                    .ok()?
                    .dyn_into::<js_sys::Function>()
                    .ok()
            })
    }

    pub(in crate::speech) async fn available() -> bool {
        constructor().is_some()
    }

    pub(in crate::speech) fn start(
        request: SpeechRequest,
        events: SpeechSink,
    ) -> Box<dyn SpeechControl> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let control = Box::new(Control { id });
        let Some(constructor) = constructor() else {
            events.end(Some(SpeechError::Unavailable));
            return control;
        };
        let recognition = match js_sys::Reflect::construct(&constructor, &js_sys::Array::new()) {
            Ok(recognition) => recognition.unchecked_into::<SpeechRecognition>(),
            Err(error) => {
                log::warn!("speech recognition could not start: {error:?}");
                events.end(Some(SpeechError::Unavailable));
                return control;
            }
        };
        if let Err(error) = recognition.set_continuous(true) {
            log::debug!("speech recognition is not continuous: {error:?}");
        }
        recognition.set_interim_results(request.interim);
        if let Some(lang) = &request.lang {
            recognition.set_lang(lang);
        }
        let handlers: [Handler; 4] = [
            Closure::new(move |_: Event| started(id)),
            Closure::new(move |event: Event| heard(id, event)),
            Closure::new(move |event: Event| failed(id, event)),
            Closure::new(move |_: Event| finish(id, None)),
        ];
        recognition.set_onstart(Some(handlers[0].as_ref().unchecked_ref()));
        recognition.set_onresult(Some(handlers[1].as_ref().unchecked_ref()));
        recognition.set_onerror(Some(handlers[2].as_ref().unchecked_ref()));
        recognition.set_onend(Some(handlers[3].as_ref().unchecked_ref()));
        // The module aborted the session before (`Control::abort`): none
        // is left here.
        let old = SESSION.with(|s| {
            s.borrow_mut().replace(Session {
                id,
                sink: events,
                interim: request.interim,
                recognition: recognition.clone(),
                _handlers: handlers,
                stopping: false,
                text: String::new(),
            })
        });
        if let Some(old) = old {
            close(&old);
        }
        if let Err(error) = recognition.start() {
            log::warn!("speech recognition could not start: {error:?}");
            finish(id, Some(SpeechError::Failed));
        }
        control
    }

    /// Controls session `id`. It only holds the id: the page has one
    /// thread, which every call comes on.
    struct Control {
        id: u64,
    }

    impl SpeechControl for Control {
        fn stop(&mut self) {
            let id = self.id;
            let recognition = SESSION.with(|s| {
                let mut s = s.borrow_mut();
                let session = s.as_mut().filter(|s| s.id == id)?;
                session.stopping = true;
                Some(session.recognition.clone())
            });
            if let Some(recognition) = recognition {
                recognition.stop();
            }
        }

        fn abort(&mut self) {
            if let Some(session) = take(self.id) {
                close(&session);
            }
        }
    }

    /// The sink of session `id`, while it runs.
    fn sink(id: u64) -> Option<SpeechSink> {
        SESSION.with(|s| {
            s.borrow()
                .as_ref()
                .filter(|s| s.id == id)
                .map(|s| s.sink.clone())
        })
    }

    /// The recognition's `start`: the microphone is on.
    fn started(id: u64) {
        if let Some(sink) = sink(id) {
            sink.start();
        }
    }

    /// The recognition's `result`: the transcript changed.
    fn heard(id: u64, event: Event) {
        let event: SpeechRecognitionEvent = event.unchecked_into();
        let Some(results) = event.results() else {
            return;
        };
        let text = transcript(
            (0..results.length())
                .filter_map(|i| results.get(i)?.get(0))
                .map(|best| best.transcript()),
        );
        let sink = SESSION.with(|s| {
            let mut s = s.borrow_mut();
            let session = s.as_mut().filter(|s| s.id == id)?;
            if session.text == text {
                return None;
            }
            session.text.clone_from(&text);
            // Without interim results, the transcript comes final, at
            // the end.
            session.interim.then(|| session.sink.clone())
        });
        if let Some(sink) = sink {
            sink.result(text, false);
        }
    }

    /// The recognition's `error`, which its `end` follows.
    fn failed(id: u64, event: Event) {
        let code = js_sys::Reflect::get(&event, &JsValue::from_str("error"))
            .ok()
            .and_then(|code| code.as_string())
            .unwrap_or_default();
        let Some((stopping, heard)) = SESSION.with(|s| {
            s.borrow()
                .as_ref()
                .filter(|s| s.id == id)
                .map(|s| (s.stopping, !s.text.is_empty()))
        }) else {
            return;
        };
        log::debug!("speech recognition ended: {code}");
        finish(id, speech_error(&code, stopping, heard));
    }

    /// Ends session `id`: what it heard, final, unless it failed.
    fn finish(id: u64, error: Option<SpeechError>) {
        let Some(session) = take(id) else {
            return;
        };
        close(&session);
        if error.is_none() && !session.text.is_empty() {
            session.sink.result(session.text.clone(), true);
        }
        session.sink.end(error);
        // Dropping the session drops the handler that may be running
        // now: wasm-bindgen frees it once its call returns.
    }

    fn take(id: u64) -> Option<Session> {
        SESSION.with(|s| {
            let mut s = s.borrow_mut();
            if s.as_ref().is_some_and(|s| s.id == id) {
                s.take()
            } else {
                None
            }
        })
    }

    /// Turns `session`'s recognition off and detaches its handlers, which
    /// go with it: nothing of it reaches the app any more.
    fn close(session: &Session) {
        let recognition = &session.recognition;
        recognition.set_onstart(None);
        recognition.set_onresult(None);
        recognition.set_onerror(None);
        recognition.set_onend(None);
        // Nothing once it ended.
        recognition.abort();
    }
}
