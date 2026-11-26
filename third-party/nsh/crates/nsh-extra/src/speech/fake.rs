//! The recognizer of headless runs (`nsh test`): the fake
//! `"nsh-extra/speech"` ([`nsh_core::fake`]), which the headless driver
//! installs as the module's backend before the app starts. A test calls it
//! by name (TS `app.fake("nsh-extra/speech", method, args)`, Rust
//! `Headless::call_fake`): `hear` `[text]` speaks for the user, `end`
//! `[]` / `[error]` ends the session, and `requests` `[]` lists what the
//! sessions asked for (`[{ lang, interim }]`); the app's sessions start
//! listening at once, as if the user allowed the microphone. The website's
//! `Speech` section documents the methods for apps.

use std::sync::{Arc, Mutex, MutexGuard};

use nsh_core::{JsonValue, fake::Fake};

use super::{SpeechBackend, SpeechControl, SpeechError, SpeechRequest, SpeechSink};

/// The name tests call the fake by.
pub(crate) const NAME: &str = "nsh-extra/speech";

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

/// The fake recognizer the test speaks into.
#[derive(Clone, Default)]
pub(crate) struct FakeSpeech(Arc<Mutex<Sessions>>);

impl FakeSpeech {
    fn sessions(&self) -> MutexGuard<'_, Sessions> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The user says `text`, the whole transcript so far: the session
    /// listening gets it as a result that is not final (unless it asked
    /// for final results only).
    fn hear(&self, text: &str) -> Result<(), String> {
        let mut sessions = self.sessions();
        let running = sessions
            .running
            .as_mut()
            .ok_or("no speech session listens")?;
        running.text = text.to_owned();
        if running.interim {
            running.sink.result(text, false);
        }
        Ok(())
    }

    /// Ends the session listening: with `error`, or (`None`) as when the
    /// user stops: its transcript as the final result, then the end
    /// (`no-speech` when nothing was heard).
    fn end(&self, error: Option<SpeechError>) -> Result<(), String> {
        let running = self
            .sessions()
            .running
            .take()
            .ok_or("no speech session listens")?;
        finish(running, error);
        Ok(())
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

fn string(args: &[JsonValue], n: usize, what: &str) -> Result<String, String> {
    args.get(n)
        .and_then(JsonValue::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{what} must be a string"))
}

impl Fake for FakeSpeech {
    fn install(&self) {
        // A new app: what an earlier one asked and left is gone.
        *self.sessions() = Sessions::default();
        super::set_backend(Some(Arc::new(self.clone())));
    }

    fn call(&self, method: &str, args: &[JsonValue]) -> Result<JsonValue, String> {
        match method {
            "requests" => Ok(JsonValue::Array(
                self.sessions()
                    .requests
                    .iter()
                    .map(|request| {
                        JsonValue::from_iter([
                            ("lang", JsonValue::from(request.lang.clone())),
                            ("interim", JsonValue::Bool(request.interim)),
                        ])
                    })
                    .collect(),
            )),
            "hear" => {
                self.hear(&string(args, 0, "the transcript")?)?;
                Ok(JsonValue::Null)
            }
            "end" => {
                let error = match args.first() {
                    None | Some(JsonValue::Null) => None,
                    Some(_) => {
                        let name = string(args, 0, "the error")?;
                        Some(
                            SpeechError::from_name(&name)
                                .ok_or_else(|| format!("no speech error {name:?}"))?,
                        )
                    }
                };
                self.end(error)?;
                Ok(JsonValue::Null)
            }
            _ => Err(format!(
                "the fake {NAME:?} has no method {method:?} (requests, hear, end)"
            )),
        }
    }
}

impl SpeechBackend for FakeSpeech {
    fn start(&self, request: SpeechRequest, sink: SpeechSink) -> Box<dyn SpeechControl> {
        let id = {
            let mut sessions = self.sessions();
            sessions.requests.push(request.clone());
            sessions.started += 1;
            sink.start();
            sessions.running = Some(Running {
                id: sessions.started,
                sink,
                interim: request.interim,
                text: String::new(),
            });
            sessions.started
        };
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
        let mut sessions = self.speech.sessions();
        if sessions.running.as_ref().is_some_and(|r| r.id == self.id) {
            sessions.running.take()
        } else {
            None
        }
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
