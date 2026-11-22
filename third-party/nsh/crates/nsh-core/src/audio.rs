//! Audio playback (`nsh`'s `Sound` and `AudioPlayer`;
//! `docs/dev/audio-design.md`): short sounds decoded once and played any
//! number of times, overlapping, and long audio streamed by a player.
//!
//! The two are two things on every platform, as kira's static and
//! streaming sounds are: a **sound** is its bytes, decoded by the platform
//! into memory at [`AudioCommand::Load`] and played from there by
//! [`AudioCommand::Play`], each play a voice of its own on the platform's
//! mixer, so `play` opens, fetches and decodes nothing. A **player** streams
//! its source as `<Video>` does, on the same engines, and has a player's
//! state: position, duration, pause, seek, rate, loop.
//!
//! Every sound and player is an object of the engine with an id the core
//! gives it ([`ids`]); its events come from the platform as
//! [`EventKind::Audio`](crate::EventKind::Audio)s on the root
//! ([`EventPayload::Audio`](crate::EventPayload::Audio)), or from an
//! [`AudioBackend`] the embedding app gave the core
//! ([`Core::set_audio`](crate::Core::set_audio), `EngineConfig::audio`),
//! which then plays everything and the platform nothing. Tests fake it the
//! same way.
//!
//! The limits are the core's ([`MAX_SOUND_BYTES`], [`MAX_SOUND_DURATION`],
//! [`MAX_SOUNDS`], [`MAX_DECODED_BYTES`]), so a bundle cannot raise them;
//! the decoded length travels to the platform ([`AudioCommand::Load`]'s
//! `max_duration`) so a small file that expands to minutes is never decoded
//! whole, and the core checks what the platform reports.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    task::{Poll, Waker},
    time::Duration,
};

use crate::image::ImageData;

/// The largest sound, encoded (its file, its `data:` URI's bytes).
pub const MAX_SOUND_BYTES: usize = 8 << 20;

/// The longest sound, decoded: longer audio is a player's.
pub const MAX_SOUND_DURATION: Duration = Duration::from_secs(5);

/// Sounds loaded at once per engine (a source loaded twice counts once).
pub const MAX_SOUNDS: usize = 64;

/// Decoded audio of the sounds loaded at once per engine.
pub const MAX_DECODED_BYTES: u64 = 16 << 20;

/// Voices of sounds playing at once per engine: past it the platform stops
/// the oldest.
pub const MAX_VOICES: usize = 32;

/// How often a player playing reports its position.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// The lowest and highest volume (silent, as recorded).
pub const VOLUME: std::ops::RangeInclusive<f32> = 0.0..=1.0;

/// The slowest and fastest playback rate.
pub const RATE: std::ops::RangeInclusive<f32> = 0.5..=2.0;

/// The media type a sound file's first bytes say it is, for bytes the app
/// gives without a name ([`crate::element::SoundSource::Bytes`]): the
/// decoders that go by a file's name or type read it from this.
/// `application/octet-stream` when no format is recognized (the platform's
/// decoder looks at the bytes alone).
pub(crate) fn sniff(bytes: &[u8]) -> &'static str {
    let at = |offset: usize, magic: &[u8]| bytes.get(offset..offset + magic.len()) == Some(magic);
    if at(0, b"RIFF") && at(8, b"WAVE") {
        "audio/wav"
    } else if at(0, b"FORM") && (at(8, b"AIFF") || at(8, b"AIFC")) {
        "audio/aiff"
    } else if at(0, b"caff") {
        "audio/x-caf"
    } else if at(0, b"fLaC") {
        "audio/flac"
    } else if at(0, b"OggS") {
        "audio/ogg"
    } else if at(4, b"ftyp") {
        "audio/mp4"
    } else if at(0, b"ID3") {
        "audio/mpeg"
    } else if let [0xFF, second, ..] = bytes {
        // An MPEG audio frame's sync word: layer bits 00 are AAC's ADTS,
        // the others MP3's.
        match second & 0xF6 {
            0xF0 => "audio/aac",
            _ if second & 0xE0 == 0xE0 => "audio/mpeg",
            _ => "application/octet-stream",
        }
    } else {
        "application/octet-stream"
    }
}

/// What the core asks of the platform (on the root,
/// [`crate::Command::Audio`]). Ids are the engine's: a sound's and a
/// player's are never the same.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum AudioCommand {
    /// Decode sound `id`'s bytes into memory, at most `max_duration` of
    /// them, and report [`AudioEvent::Loaded`] (with `truncated` when there
    /// was more) or [`AudioEvent::Failed`].
    Load {
        /// The sound.
        id: u32,
        /// Its encoded bytes.
        bytes: ImageData,
        /// Its file name or URL, for decoders that go by the extension.
        hint: String,
        /// How much to decode at most.
        max_duration: Duration,
    },
    /// Fetch sound `id`'s bytes from `url` (an `asset:/` URI, or an
    /// `http(s)` URL the core checked) and decode them as
    /// [`Self::Load`] does: where the platform fetches and the core reads
    /// nothing (the web). More than `max_bytes` fails with
    /// [`AudioError::QuotaExceeded`].
    LoadUrl {
        /// The sound.
        id: u32,
        /// Where its bytes are.
        url: String,
        /// The most bytes it may have, encoded.
        max_bytes: usize,
        /// How much to decode at most.
        max_duration: Duration,
    },
    /// Start a voice of sound `id`, over the ones playing.
    Play {
        /// The sound.
        id: u32,
        /// Its volume, in [`VOLUME`].
        volume: f32,
        /// Its rate, in [`RATE`] (the pitch goes with it).
        rate: f32,
    },
    /// Stop every voice of sound `id`.
    Stop {
        /// The sound.
        id: u32,
    },
    /// Free sound `id`'s decoded audio, its voices stopped. Nothing is
    /// reported of it after this.
    Unload {
        /// The sound.
        id: u32,
    },
    /// Make player `id` for `src` (a URL the core checked, or an
    /// `asset:/` URI), loading nothing yet.
    Open {
        /// The player.
        id: u32,
        /// What it plays.
        src: String,
        /// How it plays.
        settings: PlayerSettings,
    },
    /// Load player `id` if it has not, without playing: its
    /// [`AudioEvent::Load`] comes when it knows its duration.
    Preload {
        /// The player.
        id: u32,
    },
    /// Play player `id` from where it is (loading it first if needed),
    /// reporting [`AudioEvent::Playing`].
    Resume {
        /// The player.
        id: u32,
    },
    /// Pause player `id`, reporting [`AudioEvent::Paused`].
    Pause {
        /// The player.
        id: u32,
    },
    /// Move player `id` to `position` (clamped to its duration).
    Seek {
        /// The player.
        id: u32,
        /// Where to.
        position: Duration,
    },
    /// Change player `id`'s settings.
    Set {
        /// The player.
        id: u32,
        /// Its settings now.
        settings: PlayerSettings,
    },
    /// Stop and free player `id`. Nothing is reported of it after this.
    Close {
        /// The player.
        id: u32,
    },
}

impl AudioCommand {
    /// The sound or player the command is about.
    pub fn id(&self) -> u32 {
        match self {
            AudioCommand::Load { id, .. }
            | AudioCommand::LoadUrl { id, .. }
            | AudioCommand::Play { id, .. }
            | AudioCommand::Stop { id }
            | AudioCommand::Unload { id }
            | AudioCommand::Open { id, .. }
            | AudioCommand::Preload { id }
            | AudioCommand::Resume { id }
            | AudioCommand::Pause { id }
            | AudioCommand::Seek { id, .. }
            | AudioCommand::Set { id, .. }
            | AudioCommand::Close { id } => *id,
        }
    }

    /// Whether nothing is reported of the object after it.
    pub fn ends(&self) -> bool {
        matches!(
            self,
            AudioCommand::Unload { .. } | AudioCommand::Close { .. }
        )
    }
}

/// How a player plays.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct PlayerSettings {
    /// Its volume, in [`VOLUME`].
    pub volume: f32,
    /// Its rate, in [`RATE`] (the pitch kept where the platform can).
    pub rate: f32,
    /// It starts again at its end, without an [`AudioEvent::Ended`].
    pub looped: bool,
}

impl Default for PlayerSettings {
    fn default() -> Self {
        Self {
            volume: 1.0,
            rate: 1.0,
            looped: false,
        }
    }
}

/// What the platform reports of a sound or a player.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum AudioEvent {
    /// A sound decoded ([`AudioCommand::Load`]).
    Loaded {
        /// How long it plays (what was decoded of it).
        duration: Duration,
        /// The size of its decoded audio, for the engine's budget.
        bytes: u64,
        /// It was longer than the `max_duration` asked for: only that was
        /// decoded.
        truncated: bool,
    },
    /// A player knows its duration (`None`: a live stream).
    Load {
        /// How long it plays.
        duration: Option<Duration>,
    },
    /// A player plays.
    Playing,
    /// A player paused.
    Paused,
    /// Where a player is, every [`PROGRESS_INTERVAL`] while it plays and
    /// after a seek.
    Progress {
        /// Its position.
        position: Duration,
        /// Its duration, when known.
        duration: Option<Duration>,
    },
    /// A player started or stopped waiting for its data.
    Buffer {
        /// It waits.
        buffering: bool,
    },
    /// A player played to its end (never while it loops).
    Ended,
    /// A sound did not load, or a player failed: it plays nothing more
    /// until it is told again.
    Failed {
        /// Why.
        error: AudioError,
        /// The platform's words.
        message: String,
    },
}

/// Why a sound or a player failed (TS: the `error`'s `code`, named as the
/// Web's `MediaError` and `Speech`'s).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum AudioError {
    /// The app's capabilities, or the browser before a gesture, do not
    /// allow it (`not-allowed`).
    NotAllowed,
    /// Its source could not be fetched (`network`).
    Network,
    /// Its bytes are not audio the platform decodes (`decode`).
    Decode,
    /// Its format is not one the platform plays (`not-supported`).
    NotSupported,
    /// Past a limit of the engine's (`quota-exceeded`).
    QuotaExceeded,
    /// Nothing plays sound here (`unavailable`).
    Unavailable,
    /// Another reason, such as the output going away (`failed`).
    Failed,
}

impl AudioError {
    /// Every error, in declaration order.
    pub const ALL: [AudioError; 7] = [
        AudioError::NotAllowed,
        AudioError::Network,
        AudioError::Decode,
        AudioError::NotSupported,
        AudioError::QuotaExceeded,
        AudioError::Unavailable,
        AudioError::Failed,
    ];

    /// Its name, as JS gets it (`not-allowed`).
    pub fn as_str(self) -> &'static str {
        match self {
            AudioError::NotAllowed => "not-allowed",
            AudioError::Network => "network",
            AudioError::Decode => "decode",
            AudioError::NotSupported => "not-supported",
            AudioError::QuotaExceeded => "quota-exceeded",
            AudioError::Unavailable => "unavailable",
            AudioError::Failed => "failed",
        }
    }

    /// The error named `name` ([`Self::as_str`]).
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|e| e.as_str() == name)
    }
}

/// Where the events of one sound or player go: the app (through the core),
/// from any thread. After [`Self::close`] it takes nothing more.
#[derive(Clone)]
pub struct AudioSink {
    channel: Arc<Mutex<Channel>>,
}

#[derive(Default)]
struct Channel {
    events: VecDeque<AudioEvent>,
    waker: Option<Waker>,
    closed: bool,
}

impl std::fmt::Debug for AudioSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioSink")
            .field("closed", &self.is_closed())
            .finish()
    }
}

impl AudioSink {
    /// Reports `event`; `false` (and nothing reported) once closed.
    pub fn send(&self, event: AudioEvent) -> bool {
        let waker = {
            let mut channel = self.channel.lock().expect("audio channel");
            if channel.closed {
                return false;
            }
            channel.events.push_back(event);
            channel.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
        true
    }

    /// Takes nothing more: the object was unloaded or closed.
    pub fn close(&self) {
        let waker = {
            let mut channel = self.channel.lock().expect("audio channel");
            channel.closed = true;
            channel.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// Whether it was closed.
    pub fn is_closed(&self) -> bool {
        self.channel.lock().expect("audio channel").closed
    }
}

/// The receiving end of an [`AudioSink`], polled on the engine thread.
pub(crate) struct AudioEvents {
    channel: Arc<Mutex<Channel>>,
}

impl AudioEvents {
    /// The next event; `None` once the sink is closed and drained.
    pub(crate) fn poll_next(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<AudioEvent>> {
        let mut channel = self.channel.lock().expect("audio channel");
        if let Some(event) = channel.events.pop_front() {
            return Poll::Ready(Some(event));
        }
        if channel.closed {
            return Poll::Ready(None);
        }
        channel.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

/// An object's sink and the events it reports.
pub(crate) fn channel() -> (AudioSink, AudioEvents) {
    let channel = Arc::new(Mutex::new(Channel::default()));
    (
        AudioSink {
            channel: channel.clone(),
        },
        AudioEvents { channel },
    )
}

/// Plays sound in place of the platform: an embedding app's own audio
/// stack, or a test's fake.
pub trait AudioBackend: Send + Sync {
    /// Whether it plays sound now (TS: `Sound.available()`).
    fn available(&self) -> bool {
        true
    }

    /// Carries out `command`, reporting what happens to the object it is
    /// about to `events` (from any thread). The core sends a command only
    /// for an object it opened with a [`AudioCommand::Load`] or
    /// [`AudioCommand::Open`] and has not closed, and drops what is
    /// reported after [`AudioCommand::Unload`] / [`AudioCommand::Close`].
    fn command(&self, command: AudioCommand, events: &AudioSink);
}

/// The ids of a process's sounds and players: unique, so an event of an
/// object a backend closed late never reaches another.
pub(crate) fn ids() -> u32 {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Checks a volume: in [`VOLUME`], or why not.
pub fn check_volume(volume: f32) -> Result<f32, String> {
    if VOLUME.contains(&volume) {
        Ok(volume)
    } else {
        Err(format!("`volume` must be from 0 to 1, not {volume}"))
    }
}

/// Checks a rate: in [`RATE`], or why not.
pub fn check_rate(rate: f32) -> Result<f32, String> {
    if RATE.contains(&rate) {
        Ok(rate)
    } else {
        Err(format!("`rate` must be from 0.5 to 2, not {rate}"))
    }
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
    fn bytes_say_their_format() {
        let wav = [b"RIFF".as_slice(), &[0; 4], b"WAVEfmt "].concat();
        assert_eq!(sniff(&wav), "audio/wav");
        assert_eq!(sniff(b"FORM\0\0\0\0AIFC"), "audio/aiff");
        assert_eq!(sniff(b"caff\0\x01"), "audio/x-caf");
        assert_eq!(sniff(b"fLaC\0"), "audio/flac");
        assert_eq!(sniff(b"OggS\0"), "audio/ogg");
        assert_eq!(sniff(b"\0\0\0\x20ftypM4A "), "audio/mp4");
        assert_eq!(sniff(b"ID3\x04"), "audio/mpeg");
        assert_eq!(sniff(&[0xFF, 0xFB, 0x90]), "audio/mpeg");
        assert_eq!(sniff(&[0xFF, 0xF1, 0x50]), "audio/aac");
        assert_eq!(sniff(b"RIFF"), "application/octet-stream");
        assert_eq!(sniff(&[]), "application/octet-stream");
        assert_eq!(sniff(&[0xFF, 0x00]), "application/octet-stream");
    }

    #[test]
    fn names() {
        for error in AudioError::ALL {
            assert_eq!(AudioError::from_name(error.as_str()), Some(error));
        }
        assert_eq!(AudioError::NotAllowed.as_str(), "not-allowed");
        assert_eq!(AudioError::from_name("aborted"), None);
    }

    #[test]
    fn ranges() {
        assert_eq!(check_volume(0.0), Ok(0.0));
        assert!(check_volume(1.5).is_err());
        assert!(check_volume(f32::NAN).is_err());
        assert_eq!(check_rate(2.0), Ok(2.0));
        assert!(check_rate(0.25).is_err());
        assert!(check_rate(f32::INFINITY).is_err());
    }

    /// Events come in order, wake the receiver, and stop once closed.
    #[test]
    fn nothing_after_close() {
        let (sink, mut events) = channel();
        let count = Arc::new(Count(Mutex::new(0)));
        let waker = Waker::from(count.clone());
        let mut cx = Context::from_waker(&waker);
        assert_eq!(events.poll_next(&mut cx), Poll::Pending);
        assert!(sink.send(AudioEvent::Playing));
        assert_eq!(*count.0.lock().unwrap(), 1);
        assert!(sink.send(AudioEvent::Ended));
        sink.clone().close();
        assert!(sink.is_closed());
        assert!(!sink.send(AudioEvent::Paused));
        assert_eq!(
            events.poll_next(&mut cx),
            Poll::Ready(Some(AudioEvent::Playing))
        );
        assert_eq!(
            events.poll_next(&mut cx),
            Poll::Ready(Some(AudioEvent::Ended))
        );
        assert_eq!(events.poll_next(&mut cx), Poll::Ready(None));
    }

    #[test]
    fn commands_name_their_object() {
        assert_eq!(AudioCommand::Stop { id: 7 }.id(), 7);
        assert!(AudioCommand::Close { id: 1 }.ends());
        assert!(!AudioCommand::Pause { id: 1 }.ends());
    }
}
