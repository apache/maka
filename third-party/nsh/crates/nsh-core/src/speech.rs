//! Speech recognition (dictation; `nsh`'s `Speech`): the user speaks, the
//! app gets the transcript as it grows.
//!
//! A session starts with a [`SpeechRequest`]: the platform asks for the
//! microphone and the recognizer (the system's prompts, once), listens, and
//! reports [`SpeechEvent`]s: [`SpeechEvent::Start`] once it hears,
//! [`SpeechEvent::Result`] with the whole transcript so far each time it
//! changes, and one [`SpeechEvent::End`] (with a [`SpeechError`] when it
//! failed), after which nothing comes. Stopping a session lets the
//! recognizer finish what it heard (a last, final result, then the end);
//! aborting it ends it at once and drops what was not reported. One
//! session runs at a time per engine: starting another aborts the one
//! running.
//!
//! On the platforms a session is [`Command::Speech`](crate::Command::Speech)s
//! on the root ([`SpeechCommand`]) answered by the root's
//! [`EventKind::Speech`](crate::EventKind::Speech)
//! ([`EventPayload::Speech`](crate::EventPayload::Speech)), sent only where
//! [`Environment::speech`](crate::platform::Environment::speech) says the
//! platform recognizes speech (macOS and iOS: the Speech framework fed by
//! the microphone). An embedding app can recognize speech its own way: a
//! [`SpeechBackend`] given to the core
//! ([`Core::set_speech`](crate::Core::set_speech), `EngineConfig::speech`)
//! runs every session, and the platform's recognizer is never used. Tests
//! fake sessions the same way.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    task::{Poll, Waker},
};

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
    /// Every error, in declaration order.
    pub const ALL: [SpeechError; 7] = [
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
        Self::ALL.into_iter().find(|e| e.as_str() == name)
    }
}

/// What the core asks of the platform (on the root, [`crate::Command::Speech`]).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SpeechCommand {
    /// Start session `id`: ask for the microphone and the recognizer, then
    /// listen, reporting [`EventKind::Speech`](crate::EventKind::Speech)
    /// `id` until its [`SpeechEvent::End`]. A session of the platform's
    /// still running when another starts is aborted first.
    Start {
        /// The session.
        id: u32,
        /// What it asks for.
        request: SpeechRequest,
    },
    /// Stop listening to session `id` and finish recognizing what was
    /// heard: its last result, then its end.
    Stop {
        /// The session.
        id: u32,
    },
    /// End session `id` at once, its microphone off. The core already
    /// reported its end to the app: what the platform reports of it after
    /// this is dropped.
    Abort {
        /// The session.
        id: u32,
    },
}

/// Where a session's events go: the app (through the core), from any
/// thread. After [`SpeechEvent::End`] it takes nothing more.
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
    /// Reports `event`; `false` (and nothing reported) once the session
    /// ended. An [`SpeechEvent::End`] ends it.
    pub fn send(&self, event: SpeechEvent) -> bool {
        let waker = {
            let mut channel = self.channel.lock().expect("speech channel");
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
        self.channel.lock().expect("speech channel").ended
    }
}

/// The receiving end of a session's [`SpeechSink`], polled on the engine
/// thread.
pub(crate) struct SpeechEvents {
    channel: Arc<Mutex<Channel>>,
}

impl SpeechEvents {
    /// The next event; `None` after the end was taken.
    pub(crate) fn poll_next(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<SpeechEvent>> {
        let mut channel = self.channel.lock().expect("speech channel");
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
pub(crate) fn channel() -> (SpeechSink, SpeechEvents) {
    let channel = Arc::new(Mutex::new(Channel::default()));
    (
        SpeechSink {
            channel: channel.clone(),
        },
        SpeechEvents { channel },
    )
}

/// A running session of a [`SpeechBackend`].
pub trait SpeechControl {
    /// Stops listening and finishes recognizing what was heard: the last
    /// result, then the end, through the session's sink.
    fn stop(&mut self);
    /// Ends the session at once, its microphone off. The core already
    /// ended the sink.
    fn abort(&mut self);
}

/// Recognizes speech in place of the platform: an embedding app's own
/// recognizer, or a test's fake.
pub trait SpeechBackend: Send + Sync {
    /// Whether it recognizes speech now (TS: `Speech.available()`).
    fn available(&self) -> bool {
        true
    }

    /// Starts a session for `request`, reporting to `events` (from any
    /// thread) until it ends; what controls it.
    fn start(&self, request: SpeechRequest, events: SpeechSink) -> Box<dyn SpeechControl>;
}

#[cfg(test)]
mod tests {
    use std::task::{Context, Wake};

    use super::*;

    struct Count(Mutex<u32>);

    impl Wake for Count {
        fn wake(self: Arc<Self>) {
            *self.0.lock().unwrap() += 1;
        }
    }

    #[test]
    fn names() {
        for error in SpeechError::ALL {
            assert_eq!(SpeechError::from_name(error.as_str()), Some(error));
        }
        assert_eq!(SpeechError::NotAllowed.as_str(), "not-allowed");
        assert_eq!(SpeechError::from_name("aborted"), None);
    }

    /// Events come in order, wake the receiver, and stop at the end.
    #[test]
    fn nothing_after_the_end() {
        let (sink, mut events) = channel();
        let count = Arc::new(Count(Mutex::new(0)));
        let waker = Waker::from(count.clone());
        let mut cx = Context::from_waker(&waker);
        assert_eq!(events.poll_next(&mut cx), Poll::Pending);
        assert!(sink.start());
        assert_eq!(*count.0.lock().unwrap(), 1);
        assert!(sink.result("hel", false));
        assert!(sink.clone().end(Some(SpeechError::NoSpeech)));
        assert!(sink.is_ended());
        assert!(!sink.result("hello", true));
        assert!(!sink.end(None));
        assert_eq!(
            events.poll_next(&mut cx),
            Poll::Ready(Some(SpeechEvent::Start))
        );
        assert_eq!(
            events.poll_next(&mut cx),
            Poll::Ready(Some(SpeechEvent::Result {
                text: "hel".into(),
                is_final: false
            }))
        );
        assert_eq!(
            events.poll_next(&mut cx),
            Poll::Ready(Some(SpeechEvent::End {
                error: Some(SpeechError::NoSpeech)
            }))
        );
        assert_eq!(events.poll_next(&mut cx), Poll::Ready(None));
    }
}
