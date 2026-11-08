//! Sound on Apple platforms (`Command::Audio`, `nsh`'s `Sound` and
//! `AudioPlayer`; `docs/dev/audio-design.md`). Shared by macOS and iOS (both
//! backends depend on this crate): AVFoundation is loaded and messaged
//! dynamically, as the video and speech code do.
//!
//! - **Sounds** decode once, at their load, into an `AVAudioPCMBuffer`
//!   (`AVAudioFile` over a temporary file of their bytes, at most the
//!   duration the core allows) on a background queue, so a load never
//!   holds up the main thread's frames, and play from memory: each play is a voice,
//!   an `AVAudioPlayerNode` through an `AVAudioUnitVarispeed` (the rate,
//!   pitch with it) into the engine's mixer. Voices are reused once their
//!   buffer played; past [`MAX_VOICES`] the oldest stops.
//! - **Players** are `AVPlayer`s without a layer, made at their first
//!   preload or play: the load is polled until the item is ready or fails
//!   (a paused player reports no time), the position comes from a periodic
//!   time observer, the end from `AVPlayerItemDidPlayToEndTimeNotification`.
//!
//! Everything is one [`Speaker`] per surface, so per engine (one surface is
//! one engine), on the main thread; it is dropped with the surface. The
//! `AVAudioEngine` starts at the first play and again after the system
//! stopped it (a device change): an output that goes away is silence, never
//! an error the app sees. On iOS the audio session is `ambient` (mixes with
//! other apps' audio, follows the silent switch), set at the first sound.

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    ffi::CStr,
    ptr,
    ptr::NonNull,
    rc::{Rc, Weak},
    sync::OnceLock,
    time::{Duration, Instant},
};

use block2::RcBlock;
use dispatch2::{DispatchQoS, DispatchQueue, GlobalQueueIdentifier, MainThreadBound};
use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    audio::{AudioCommand, AudioError, AudioEvent, MAX_VOICES, PROGRESS_INTERVAL, PlayerSettings},
    image::loader::AssetBase,
};
use nsh_engine::EngineControl;
use objc2::{
    Encode, Encoding, MainThreadMarker, msg_send,
    rc::{Allocated, Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue, NSString, NSURL};

/// `AVAudioPlayerNodeBufferInterrupts`: a buffer scheduled replaces what
/// the node was playing.
const BUFFER_INTERRUPTS: usize = 2;

/// One engine's sounds and players.
#[derive(Default)]
pub struct Speaker {
    /// Shared with the decodes in flight, which find it again (or not:
    /// the surface closed) when they finish.
    inner: Rc<RefCell<Inner>>,
}

#[derive(Default)]
struct Inner {
    /// Made at the first sound.
    engine: Option<Retained<AnyObject>>,
    sounds: HashMap<u32, Decoded>,
    /// The sounds decoding; an unload before the decode finished takes
    /// the id out, and the decoded sound is dropped.
    loading: HashSet<u32>,
    voices: Vec<Voice>,
    players: HashMap<u32, Rc<Player>>,
}

/// A sound decoded into memory.
struct Decoded {
    buffer: Retained<AnyObject>,
    format: Retained<AnyObject>,
    duration: Duration,
}

/// A player node and its varispeed, attached to the engine.
struct Voice {
    player: Retained<AnyObject>,
    varispeed: Retained<AnyObject>,
    /// The format it is connected with.
    format: Option<Retained<AnyObject>>,
    /// The sound it plays, and until when.
    sound: Option<u32>,
    until: Instant,
    started: Instant,
}

impl Drop for Speaker {
    fn drop(&mut self) {
        let inner = self.inner.borrow();
        for player in inner.players.values() {
            player.close();
        }
        if let Some(engine) = &inner.engine {
            // SAFETY: AVAudioEngine's documented API.
            let _: () = unsafe { msg_send![engine, stop] };
        }
    }
}

/// Applies `command` for the engine `control` reports to, `asset:/` URIs
/// resolving against `base`. On the main thread.
pub fn command(
    speaker: &Speaker,
    control: &EngineControl,
    command: &AudioCommand,
    base: Option<&AssetBase>,
) {
    let id = command.id();
    let report = |event| report(control, id, event);
    if !av_foundation() {
        if matches!(
            command,
            AudioCommand::Load { .. } | AudioCommand::Open { .. }
        ) {
            report(failed(
                AudioError::Unavailable,
                "AVFoundation is not available",
            ));
        }
        return;
    }
    match command {
        AudioCommand::Load {
            bytes,
            hint,
            max_duration,
            ..
        } => speaker.load(id, bytes, hint, *max_duration, control),
        // The core reads the bytes here: URLs are the web's.
        AudioCommand::LoadUrl { .. } => {
            report(failed(
                AudioError::NotSupported,
                "sounds are loaded from their bytes here",
            ));
        }
        AudioCommand::Play { volume, rate, .. } => speaker.play(id, *volume, *rate),
        AudioCommand::Stop { .. } => speaker.stop(id),
        AudioCommand::Unload { .. } => {
            speaker.stop(id);
            let mut inner = speaker.inner.borrow_mut();
            inner.sounds.remove(&id);
            inner.loading.remove(&id);
        }
        AudioCommand::Open { src, settings, .. } => {
            let player = Player::new(id, src, *settings, base, control.clone());
            speaker.inner.borrow_mut().players.insert(id, player);
        }
        AudioCommand::Close { .. } => {
            if let Some(player) = speaker.inner.borrow_mut().players.remove(&id) {
                player.close();
            }
        }
        other => {
            let player = speaker.inner.borrow().players.get(&id).cloned();
            if let Some(player) = player {
                player.apply(other);
            }
        }
    }
}

fn report(control: &EngineControl, id: u32, event: AudioEvent) {
    control.dispatch_event(ROOT_ID, EventKind::Audio, EventPayload::Audio { id, event });
}

fn failed(error: AudioError, message: &str) -> AudioEvent {
    AudioEvent::Failed {
        error,
        message: message.to_owned(),
    }
}

// --- Sounds ------------------------------------------------------------------

/// The file extension `hint` (a file name, a URL or a `data:` URI) names,
/// which AudioToolbox goes by for formats without a header.
fn extension(hint: &str) -> &'static str {
    let hint = hint.to_ascii_lowercase();
    let mime = hint
        .strip_prefix("data:")
        .map(|rest| rest.split([';', ',']).next().unwrap_or_default());
    let name = hint.split(['?', '#']).next().unwrap_or_default();
    let ext = name.rsplit_once('.').map_or("", |(_, ext)| ext);
    match (mime, ext) {
        (Some("audio/mpeg" | "audio/mp3"), _) | (None, "mp3") => "mp3",
        (Some("audio/aac" | "audio/mp4" | "audio/x-m4a" | "audio/m4a"), _)
        | (None, "m4a" | "aac" | "mp4") => "m4a",
        (Some("audio/aiff" | "audio/x-aiff"), _) | (None, "aif" | "aiff") => "aiff",
        (Some("audio/x-caf"), _) | (None, "caf") => "caf",
        (Some("audio/flac"), _) | (None, "flac") => "flac",
        _ => "wav",
    }
}

/// Decodes `bytes` into memory, at most `max` of them: the sound and its
/// `Loaded`.
fn decode(bytes: &[u8], hint: &str, max: Duration) -> Result<(Decoded, AudioEvent), String> {
    // AVAudioFile reads files only: the bytes go to a temporary one, read
    // and removed at once.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "nsh-sound-{}-{n}.{}",
        std::process::id(),
        extension(hint)
    ));
    std::fs::write(&path, bytes).map_err(|e| format!("cannot write the sound: {e}"))?;
    let result = read(&path, max);
    let _ = std::fs::remove_file(&path);
    result
}

fn read(path: &std::path::Path, max: Duration) -> Result<(Decoded, AudioEvent), String> {
    let (Some(file_cls), Some(buffer_cls)) = (class(c"AVAudioFile"), class(c"AVAudioPCMBuffer"))
    else {
        return Err("AVAudioFile is not available".into());
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let mut error: *mut AnyObject = ptr::null_mut();
    // SAFETY: AVAudioFile's and AVAudioPCMBuffer's documented API, sent
    // dynamically; `error` is an out parameter the call may set.
    unsafe {
        let alloc: Allocated<AnyObject> = msg_send![file_cls, alloc];
        let file: Option<Retained<AnyObject>> =
            msg_send![alloc, initForReading: &*url, error: &mut error];
        let Some(file) = file else {
            return Err(describe(error, "the sound cannot be decoded"));
        };
        let format: Retained<AnyObject> = msg_send![&file, processingFormat];
        let rate: f64 = msg_send![&format, sampleRate];
        let channels: u32 = msg_send![&format, channelCount];
        let length: i64 = msg_send![&file, length];
        if rate <= 0.0 || length <= 0 {
            return Err("the sound is empty".into());
        }
        let allowed = (max.as_secs_f64() * rate).ceil() as i64;
        let frames = length.min(allowed).min(i64::from(u32::MAX)) as u32;
        let alloc: Allocated<AnyObject> = msg_send![buffer_cls, alloc];
        let buffer: Option<Retained<AnyObject>> =
            msg_send![alloc, initWithPCMFormat: &*format, frameCapacity: frames];
        let Some(buffer) = buffer else {
            return Err("no memory for the sound".into());
        };
        let read: Bool =
            msg_send![&file, readIntoBuffer: &*buffer, frameCount: frames, error: &mut error];
        if !read.as_bool() {
            return Err(describe(error, "the sound cannot be read"));
        }
        let decoded: u32 = msg_send![&buffer, frameLength];
        let duration = Duration::from_secs_f64(f64::from(decoded) / rate);
        // The processing format is deinterleaved 32-bit floats.
        let bytes = u64::from(decoded) * u64::from(channels) * 4;
        let event = AudioEvent::Loaded {
            duration,
            bytes,
            truncated: length > i64::from(frames),
        };
        Ok((
            Decoded {
                buffer,
                format,
                duration,
            },
            event,
        ))
    }
}

/// The localized description of `error` (an `NSError`, or null).
///
/// # Safety
///
/// `error` must be null or an `NSError` the caller owns no reference to
/// (an autoreleased out parameter).
unsafe fn describe(error: *mut AnyObject, fallback: &str) -> String {
    if error.is_null() {
        return fallback.to_owned();
    }
    // SAFETY: the caller's guarantee; `localizedDescription` is NSError's.
    unsafe {
        let description: Retained<NSString> = msg_send![&*error, localizedDescription];
        format!("{fallback}: {description}")
    }
}

/// What a decode hands from its background queue to the main thread.
struct Decode(Result<(Decoded, AudioEvent), String>);

// SAFETY: the buffer and format are made on the decoding queue and touched
// by nothing there once made; the main thread is the only one to use them
// after, so they are never used from two threads at once (AVAudioPCMBuffer
// and AVAudioFormat may move between threads).
unsafe impl Send for Decode {}

impl Decode {
    /// Taken whole, so a closure moves the `Send` wrapper rather than the
    /// field.
    fn into_result(self) -> Result<(Decoded, AudioEvent), String> {
        self.0
    }
}

impl Speaker {
    /// Decodes `bytes` on a background queue, then keeps the sound and
    /// reports its load on the main thread, unless it was unloaded (or the
    /// surface closed) in the meantime.
    fn load(
        &self,
        id: u32,
        bytes: &nsh_core::image::ImageData,
        hint: &str,
        max: Duration,
        control: &EngineControl,
    ) {
        let mtm = MainThreadMarker::new().expect("audio commands run on the main thread");
        self.inner.borrow_mut().loading.insert(id);
        let speaker = MainThreadBound::new(Rc::downgrade(&self.inner), mtm);
        let (bytes, hint, control) = (bytes.clone(), hint.to_owned(), control.clone());
        DispatchQueue::global_queue(GlobalQueueIdentifier::QualityOfService(
            DispatchQoS::UserInitiated,
        ))
        .exec_async(move || {
            // The queue's threads drain their pools only now and then:
            // NSErrors and AVFoundation's autoreleased objects go at once.
            let decoded = Decode(autoreleasepool(|_| decode(&bytes, &hint, max)));
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("the main queue");
                let Some(inner) = speaker.into_inner(mtm).upgrade() else {
                    return;
                };
                let mut inner = inner.borrow_mut();
                if !inner.loading.remove(&id) {
                    return;
                }
                match decoded.into_result() {
                    Ok((decoded, event)) => {
                        inner.sounds.insert(id, decoded);
                        drop(inner);
                        report(&control, id, event);
                    }
                    Err(message) => {
                        drop(inner);
                        report(&control, id, failed(AudioError::Decode, &message));
                    }
                }
            });
        });
    }

    /// The engine, made and started if needed (again after the system
    /// stopped it); `None` when it cannot start: the sound is silence.
    fn engine(inner: &mut Inner) -> Option<Retained<AnyObject>> {
        if inner.engine.is_none() {
            session();
            let cls = class(c"AVAudioEngine")?;
            // SAFETY: AVAudioEngine's documented API.
            let engine: Retained<AnyObject> = unsafe {
                let alloc: Allocated<AnyObject> = msg_send![cls, alloc];
                msg_send![alloc, init]
            };
            // The mixer exists, and is connected to the output, once asked
            // for.
            // SAFETY: as above.
            let _: Retained<AnyObject> = unsafe { msg_send![&engine, mainMixerNode] };
            inner.engine = Some(engine);
        }
        let engine = inner.engine.clone()?;
        // SAFETY: AVAudioEngine's documented API; `error` is an out
        // parameter.
        unsafe {
            let running: Bool = msg_send![&engine, isRunning];
            if !running.as_bool() {
                let mut error: *mut AnyObject = ptr::null_mut();
                let started: Bool = msg_send![&engine, startAndReturnError: &mut error];
                if !started.as_bool() {
                    log::warn!("{}", describe(error, "the audio engine did not start"));
                    return None;
                }
            }
        }
        Some(engine)
    }

    fn play(&self, id: u32, volume: f32, rate: f32) {
        let mut inner = self.inner.borrow_mut();
        let Some((buffer, format, duration)) = inner
            .sounds
            .get(&id)
            .map(|s| (s.buffer.clone(), s.format.clone(), s.duration))
        else {
            return;
        };
        let Some(engine) = Self::engine(&mut inner) else {
            return;
        };
        let now = Instant::now();
        let index = match inner.voices.iter().position(|v| v.until <= now) {
            Some(free) => free,
            None if inner.voices.len() < MAX_VOICES => {
                let Some(voice) = Voice::new(&engine) else {
                    return;
                };
                inner.voices.push(voice);
                inner.voices.len() - 1
            }
            None => {
                // The oldest stops.
                let oldest = (0..inner.voices.len())
                    .min_by_key(|&i| inner.voices[i].started)
                    .unwrap_or(0);
                // SAFETY: AVAudioPlayerNode's documented API.
                let _: () = unsafe { msg_send![&inner.voices[oldest].player, stop] };
                oldest
            }
        };
        let voice = &mut inner.voices[index];
        // SAFETY: AVAudioEngine's, AVAudioPlayerNode's and
        // AVAudioUnitVarispeed's documented API: a node is connected with
        // the format of the buffers it plays, and the mixer converts.
        unsafe {
            let same: bool = voice
                .format
                .as_ref()
                .is_some_and(|f| msg_send![f, isEqual: &*format]);
            if !same {
                let mixer: Retained<AnyObject> = msg_send![&engine, mainMixerNode];
                let _: () = msg_send![&engine, connect: &*voice.player, to: &*voice.varispeed, format: &*format];
                let _: () =
                    msg_send![&engine, connect: &*voice.varispeed, to: &*mixer, format: &*format];
                voice.format = Some(format);
            }
            let _: () = msg_send![&voice.varispeed, setRate: rate];
            let _: () = msg_send![&voice.player, setVolume: volume];
            let _: () = msg_send![
                &voice.player,
                scheduleBuffer: &*buffer,
                atTime: ptr::null::<AnyObject>(),
                options: BUFFER_INTERRUPTS,
                completionHandler: Option::<&block2::Block<dyn Fn()>>::None
            ];
            let _: () = msg_send![&voice.player, play];
        }
        voice.sound = Some(id);
        voice.started = now;
        voice.until = now + duration.div_f32(rate.max(0.01));
    }

    fn stop(&self, id: u32) {
        let mut inner = self.inner.borrow_mut();
        let now = Instant::now();
        for voice in inner.voices.iter_mut().filter(|v| v.sound == Some(id)) {
            // SAFETY: AVAudioPlayerNode's documented API.
            let _: () = unsafe { msg_send![&voice.player, stop] };
            voice.sound = None;
            voice.until = now;
        }
    }
}

impl Voice {
    fn new(engine: &AnyObject) -> Option<Voice> {
        let (player_cls, varispeed_cls) = (
            class(c"AVAudioPlayerNode")?,
            class(c"AVAudioUnitVarispeed")?,
        );
        // SAFETY: AVAudioEngine's documented API.
        unsafe {
            let alloc: Allocated<AnyObject> = msg_send![player_cls, alloc];
            let player: Retained<AnyObject> = msg_send![alloc, init];
            let alloc: Allocated<AnyObject> = msg_send![varispeed_cls, alloc];
            let varispeed: Retained<AnyObject> = msg_send![alloc, init];
            let _: () = msg_send![engine, attachNode: &*player];
            let _: () = msg_send![engine, attachNode: &*varispeed];
            let now = Instant::now();
            Some(Voice {
                player,
                varispeed,
                format: None,
                sound: None,
                until: now,
                started: now,
            })
        }
    }
}

/// On iOS, the audio session plays sound as `ambient` (once).
fn session() {
    #[cfg(target_os = "ios")]
    {
        static SET: OnceLock<()> = OnceLock::new();
        SET.get_or_init(|| {
            let Some(cls) = class(c"AVAudioSession") else {
                return;
            };
            // SAFETY: AVAudioSession's documented API; the category is the
            // value of `AVAudioSessionCategoryAmbient`.
            unsafe {
                let session: Retained<AnyObject> = msg_send![cls, sharedInstance];
                let category = NSString::from_str("AVAudioSessionCategoryAmbient");
                let mut error: *mut AnyObject = ptr::null_mut();
                let _: Bool = msg_send![&session, setCategory: &*category, error: &mut error];
            }
        });
    }
}

// --- Players -----------------------------------------------------------------

/// CoreMedia's `CMTime`.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

// SAFETY: the layout and encoding of CoreMedia's `CMTime` (`{?=qiIq}`).
unsafe impl Encode for CMTime {
    const ENCODING: Encoding = Encoding::Struct(
        "?",
        &[i64::ENCODING, i32::ENCODING, u32::ENCODING, i64::ENCODING],
    );
}

impl CMTime {
    fn from_seconds(seconds: f64) -> Self {
        Self {
            value: (seconds * 600.0).round() as i64,
            timescale: 600,
            flags: 1,
            epoch: 0,
        }
    }

    /// The time, or `None` when invalid or indefinite (a live stream).
    fn duration(&self) -> Option<Duration> {
        if self.flags & 1 == 0 || self.flags & 0x10 != 0 || self.timescale <= 0 || self.value < 0 {
            None
        } else {
            Some(Duration::from_secs_f64(
                self.value as f64 / f64::from(self.timescale),
            ))
        }
    }
}

/// A player and what it reported.
struct Player {
    id: u32,
    url: Option<Retained<NSURL>>,
    control: EngineControl,
    settings: Cell<PlayerSettings>,
    /// Made at the first preload or play.
    player: RefCell<Option<Retained<AnyObject>>>,
    time_observer: RefCell<Option<Retained<AnyObject>>>,
    end_observer: RefCell<
        Option<Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>>,
    >,
    loaded: Cell<bool>,
    failed: Cell<bool>,
    buffering: Cell<bool>,
    /// A play waits for the load.
    wants_play: Cell<bool>,
    playing: Cell<bool>,
}

impl Player {
    fn new(
        id: u32,
        src: &str,
        settings: PlayerSettings,
        base: Option<&AssetBase>,
        control: EngineControl,
    ) -> Rc<Player> {
        let url = locate(src, base);
        let player = Rc::new(Player {
            id,
            url,
            control,
            settings: Cell::new(settings),
            player: RefCell::default(),
            time_observer: RefCell::default(),
            end_observer: RefCell::default(),
            loaded: Cell::new(false),
            failed: Cell::new(false),
            buffering: Cell::new(false),
            wants_play: Cell::new(false),
            playing: Cell::new(false),
        });
        if player.url.is_none() {
            player.fail(
                AudioError::NotSupported,
                &format!("{src}: cannot resolve the source"),
            );
        }
        player
    }

    fn report(&self, event: AudioEvent) {
        report(&self.control, self.id, event);
    }

    fn fail(&self, error: AudioError, message: &str) {
        if self.failed.replace(true) {
            return;
        }
        self.playing.set(false);
        self.wants_play.set(false);
        self.report(failed(error, message));
    }

    /// The `AVPlayer`, made (and its load watched) the first time.
    fn player(self: &Rc<Self>) -> Option<Retained<AnyObject>> {
        if let Some(player) = &*self.player.borrow() {
            return Some(player.clone());
        }
        if self.failed.get() {
            return None;
        }
        let (url, cls) = (self.url.as_ref()?, class(c"AVPlayer")?);
        // SAFETY: AVPlayer's documented API.
        let player: Retained<AnyObject> = unsafe { msg_send![cls, playerWithURL: &**url] };
        let settings = self.settings.get();
        // SAFETY: AVPlayer's documented API.
        unsafe {
            let _: () = msg_send![&player, setVolume: settings.volume];
            // The rate is the one asked, when it plays, not 1 then this.
            let _: () = msg_send![&player, setAutomaticallyWaitsToMinimizeStalling: true];
        }
        *self.player.borrow_mut() = Some(player.clone());
        self.observe(&player);
        poll(Rc::downgrade(self), 0);
        Some(player)
    }

    fn observe(self: &Rc<Self>, player: &Retained<AnyObject>) {
        // SAFETY: AVPlayer's documented API.
        let item: Option<Retained<AnyObject>> = unsafe { msg_send![player, currentItem] };
        let weak = Rc::downgrade(self);
        let end = RcBlock::new(move |_: NonNull<NSNotification>| {
            if let Some(this) = weak.upgrade() {
                this.ended();
            }
        });
        // SAFETY: a documented notification, delivered on the main queue;
        // the observer is removed in `close`.
        *self.end_observer.borrow_mut() = Some(unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(&NSString::from_str(
                    "AVPlayerItemDidPlayToEndTimeNotification",
                )),
                item.as_deref(),
                Some(&NSOperationQueue::mainQueue()),
                &end,
            )
        });
        let weak = Rc::downgrade(self);
        let tick = RcBlock::new(move |time: CMTime| {
            let Some(this) = weak.upgrade() else { return };
            this.check();
            if this.playing.get() {
                this.report(AudioEvent::Progress {
                    position: time.duration().unwrap_or_default(),
                    duration: this.duration(),
                });
            }
        });
        let interval = CMTime::from_seconds(PROGRESS_INTERVAL.as_secs_f64());
        // SAFETY: AVPlayer's documented API; a nil queue is the main queue.
        *self.time_observer.borrow_mut() = Some(unsafe {
            msg_send![
                &**player,
                addPeriodicTimeObserverForInterval: interval,
                queue: ptr::null::<AnyObject>(),
                usingBlock: &*tick
            ]
        });
    }

    fn duration(&self) -> Option<Duration> {
        let player = self.player.borrow().clone()?;
        // SAFETY: AVPlayer / AVPlayerItem getters.
        unsafe {
            let item: Option<Retained<AnyObject>> = msg_send![&player, currentItem];
            let duration: CMTime = msg_send![&item?, duration];
            duration.duration()
        }
    }

    /// Reports the load (once), a failure (once) and buffering changes;
    /// starts a play that waited for the load.
    fn check(&self) {
        let Some(player) = self.player.borrow().clone() else {
            return;
        };
        // SAFETY: AVPlayer / AVPlayerItem getters.
        unsafe {
            let item: Option<Retained<AnyObject>> = msg_send![&player, currentItem];
            let Some(item) = item else { return };
            // AVPlayerItemStatus: 1 ready to play, 2 failed.
            let status: isize = msg_send![&item, status];
            if status == 2 {
                let error: *mut AnyObject = msg_send![&item, error];
                let message = describe(error, "the audio failed to load");
                let kind = if self.url.as_ref().is_some_and(|u| {
                    let scheme: Option<Retained<NSString>> = msg_send![&**u, scheme];
                    scheme.is_some_and(|s| s.to_string().starts_with("http"))
                }) {
                    AudioError::Network
                } else {
                    AudioError::Decode
                };
                self.fail(kind, &message);
                return;
            }
            if status == 1 && !self.loaded.replace(true) {
                self.report(AudioEvent::Load {
                    duration: self.duration(),
                });
                if self.wants_play.replace(false) {
                    self.start(&player);
                }
            }
            // AVPlayerTimeControlStatusWaitingToPlayAtSpecifiedRate.
            let control: isize = msg_send![&player, timeControlStatus];
            let waiting = control == 1;
            if self.buffering.replace(waiting) != waiting {
                self.report(AudioEvent::Buffer { buffering: waiting });
            }
        }
    }

    fn start(&self, player: &AnyObject) {
        let rate = self.settings.get().rate;
        // SAFETY: AVPlayer's documented API.
        let _: () = unsafe { msg_send![player, playImmediatelyAtRate: rate] };
        self.playing.set(true);
        self.report(AudioEvent::Playing);
    }

    fn ended(&self) {
        let Some(player) = self.player.borrow().clone() else {
            return;
        };
        if self.settings.get().looped {
            // SAFETY: AVPlayer's documented API.
            unsafe {
                let _: () = msg_send![&player, seekToTime: CMTime::from_seconds(0.0)];
            }
            self.start(&player);
            return;
        }
        self.playing.set(false);
        if let Some(duration) = self.duration() {
            self.report(AudioEvent::Progress {
                position: duration,
                duration: Some(duration),
            });
        }
        self.report(AudioEvent::Ended);
    }

    fn apply(self: &Rc<Self>, command: &AudioCommand) {
        match command {
            AudioCommand::Preload { .. } => {
                let _ = self.player();
            }
            AudioCommand::Resume { .. } => {
                if self.failed.get() {
                    // Told again: try again from scratch.
                    self.close();
                    self.failed.set(false);
                    self.loaded.set(false);
                }
                let Some(player) = self.player() else { return };
                if self.loaded.get() {
                    // At its end: from the start again.
                    if !self.playing.get()
                        && let Some(duration) = self.duration()
                    {
                        // SAFETY: AVPlayer's documented API.
                        let now: CMTime = unsafe { msg_send![&player, currentTime] };
                        if now.duration().is_some_and(|t| t >= duration) {
                            // SAFETY: as above.
                            let _: () = unsafe {
                                msg_send![&player, seekToTime: CMTime::from_seconds(0.0)]
                            };
                        }
                    }
                    self.start(&player);
                } else {
                    self.wants_play.set(true);
                }
            }
            AudioCommand::Pause { .. } => {
                self.wants_play.set(false);
                if let Some(player) = &*self.player.borrow() {
                    // SAFETY: AVPlayer's documented API.
                    let _: () = unsafe { msg_send![player, pause] };
                }
                if self.playing.replace(false) {
                    self.report(AudioEvent::Paused);
                }
            }
            AudioCommand::Seek { position, .. } => {
                let Some(player) = self.player() else { return };
                let zero = CMTime::from_seconds(0.0);
                // SAFETY: AVPlayer's documented API.
                let _: () = unsafe {
                    msg_send![
                        &player,
                        seekToTime: CMTime::from_seconds(position.as_secs_f64()),
                        toleranceBefore: zero,
                        toleranceAfter: zero
                    ]
                };
                let position = self.duration().map_or(*position, |d| (*position).min(d));
                self.report(AudioEvent::Progress {
                    position,
                    duration: self.duration(),
                });
            }
            AudioCommand::Set { settings, .. } => {
                self.settings.set(*settings);
                if let Some(player) = &*self.player.borrow() {
                    // SAFETY: AVPlayer's documented API.
                    unsafe {
                        let _: () = msg_send![player, setVolume: settings.volume];
                        if self.playing.get() {
                            let _: () = msg_send![player, setRate: settings.rate];
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// Stops the player and stops observing it.
    fn close(&self) {
        let player = self.player.borrow_mut().take();
        if let (Some(player), Some(token)) = (&player, self.time_observer.borrow_mut().take()) {
            // SAFETY: removes the observer this player added.
            let _: () = unsafe { msg_send![player, removeTimeObserver: &*token] };
        }
        if let Some(observer) = self.end_observer.borrow_mut().take() {
            // SAFETY: an observer token of the default center.
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
        }
        if let Some(player) = player {
            // SAFETY: AVPlayer's documented API.
            let _: () = unsafe { msg_send![&player, pause] };
        }
        self.playing.set(false);
    }
}

/// Checks the player every 100 ms until it loaded or failed (for at most a
/// minute): a paused player reports no time to the periodic observer.
fn poll(player: Weak<Player>, attempt: u32) {
    let Some(this) = player.upgrade() else { return };
    if this.player.borrow().is_none() {
        return;
    }
    this.check();
    if this.loaded.get() || this.failed.get() {
        return;
    }
    if attempt >= 600 {
        this.fail(
            AudioError::Network,
            "the audio did not load within a minute",
        );
        return;
    }
    drop(this);
    let mtm = MainThreadMarker::new().expect("main thread");
    let state = MainThreadBound::new(player, mtm);
    let when = dispatch2::DispatchTime::NOW.time(100_000_000);
    let _ = DispatchQueue::main().after(when, move || {
        let mtm = MainThreadMarker::new().expect("main queue");
        poll(state.into_inner(mtm), attempt + 1);
    });
}

/// The URL of `src` (`asset:/` URIs against `base`).
fn locate(src: &str, base: Option<&AssetBase>) -> Option<Retained<NSURL>> {
    if let Some(path) = src.strip_prefix("asset:/") {
        let path = path.trim_start_matches('/');
        return match base? {
            AssetBase::Http(url) => NSURL::URLWithString(&NSString::from_str(&format!(
                "{}/{path}",
                url.trim_end_matches('/')
            ))),
            dirs => dirs
                .file(path)
                .map(|file| NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy()))),
        };
    }
    if src.contains("://") {
        NSURL::URLWithString(&NSString::from_str(src))
    } else if src.is_empty() {
        None
    } else {
        Some(NSURL::fileURLWithPath(&NSString::from_str(src)))
    }
}

fn load(framework: &CStr) -> bool {
    // SAFETY: loads a system framework; the handle is never closed.
    let loaded = !unsafe { libc::dlopen(framework.as_ptr(), libc::RTLD_LAZY) }.is_null();
    if !loaded {
        log::error!("cannot load {}", framework.to_string_lossy());
    }
    loaded
}

fn av_foundation() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| load(c"/System/Library/Frameworks/AVFoundation.framework/AVFoundation"))
}

fn class(name: &CStr) -> Option<&'static AnyClass> {
    AnyClass::get(name)
}

#[cfg(test)]
mod tests {
    use super::extension;

    #[test]
    fn extensions_come_from_names_and_media_types() {
        assert_eq!(extension("sounds/click.MP3"), "mp3");
        assert_eq!(extension("https://a.com/x.m4a?v=2"), "m4a");
        assert_eq!(extension("data:audio/mpeg;base64,AA"), "mp3");
        assert_eq!(extension("data:audio/wav,%00"), "wav");
        assert_eq!(extension("click"), "wav");
    }
}
