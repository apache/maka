//! The speech recognizer of a headless app: the test speaks for the user
//! ([`super::Headless::hear`]) and ends the session
//! ([`super::Headless::end_speech`]); the app's sessions start listening
//! at once, as if the user allowed the microphone.

use std::sync::{Arc, Mutex};

use nsh_core::speech::{SpeechBackend, SpeechControl, SpeechError, SpeechRequest, SpeechSink};

/// What the fake recognizer heard and runs.
#[derive(Default)]
struct Sessions {
    /// The session listening and its transcript so far.
    running: Option<Running>,
    /// What every session asked for, in order.
    requests: Vec<SpeechRequest>,
    /// Sessions started, for their ids.
    started: u64,
}

struct Running {
    id: u64,
    sink: SpeechSink,
    interim: bool,
    text: String,
}

/// A [`SpeechBackend`] the test speaks into.
#[derive(Clone, Default)]
pub(crate) struct FakeSpeech(Arc<Mutex<Sessions>>);

impl FakeSpeech {
    fn with<T>(&self, f: impl FnOnce(&mut Sessions) -> T) -> T {
        f(&mut self.0.lock().expect("speech sessions"))
    }

    /// What every session asked for so far, in order.
    pub(crate) fn requests(&self) -> Vec<SpeechRequest> {
        self.with(|s| s.requests.clone())
    }

    /// The user says `text`, the whole transcript so far: the session
    /// listening gets it as a result that is not final (unless it asked
    /// for final results only).
    pub(crate) fn hear(&self, text: &str) -> Result<(), String> {
        self.with(|s| {
            let running = s.running.as_mut().ok_or("no speech session listens")?;
            running.text = text.to_owned();
            if running.interim {
                running.sink.result(text, false);
            }
            Ok(())
        })
    }

    /// Ends the session listening: with `error`, or (`None`) as when the
    /// user stops: its transcript as the final result, then the end
    /// (`no-speech` when nothing was heard).
    pub(crate) fn end(&self, error: Option<SpeechError>) -> Result<(), String> {
        self.with(|s| {
            let running = s.running.take().ok_or("no speech session listens")?;
            finish(running, error);
            Ok(())
        })
    }
}

fn finish(running: Running, error: Option<SpeechError>) {
    let error = match error {
        Some(error) => Some(error),
        None if running.text.is_empty() => Some(SpeechError::NoSpeech),
        None => {
            running.sink.result(running.text, true);
            None
        }
    };
    running.sink.end(error);
}

impl SpeechBackend for FakeSpeech {
    fn start(&self, request: SpeechRequest, sink: SpeechSink) -> Box<dyn SpeechControl> {
        let id = self.with(|s| {
            s.requests.push(request.clone());
            s.started += 1;
            sink.start();
            s.running = Some(Running {
                id: s.started,
                sink,
                interim: request.interim,
                text: String::new(),
            });
            s.started
        });
        Box::new(Control {
            speech: self.clone(),
            id,
        })
    }
}

/// One session of the fake recognizer.
struct Control {
    speech: FakeSpeech,
    id: u64,
}

impl Control {
    /// The session, while it is the one listening.
    fn take(&self) -> Option<Running> {
        self.speech.with(|s| {
            if s.running.as_ref().is_some_and(|r| r.id == self.id) {
                s.running.take()
            } else {
                None
            }
        })
    }
}

impl SpeechControl for Control {
    fn stop(&mut self) {
        if let Some(running) = self.take() {
            finish(running, None);
        }
    }

    fn abort(&mut self) {
        self.take();
    }
}
