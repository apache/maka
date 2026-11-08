//! Audio playback on Windows (`nsh`'s `Sound` and `AudioPlayer`;
//! `docs/dev/audio-design.md`).
//!
//! **Sounds** are decoded once, at [`AudioCommand::Load`], by Media
//! Foundation's source reader into 32-bit float PCM (at most the
//! `max_duration` the core asked for) on a decoding thread of the process
//! ([`decode_off_main`]), so a load never holds up the main thread's frames,
//! and played by XAudio2: one engine
//! per surface (made at the first play, so an app that never plays a sound
//! never opens the output) with a mastering voice, and a source voice per
//! overlapping play. A voice is reused once its buffer finished, past
//! [`MAX_VOICES`] the oldest stops. A play's volume is the voice's volume
//! and its rate the voice's frequency ratio, so the pitch goes with it. An
//! output that fails (no device, a device change) is silence, never a
//! crash: the engine is dropped and made again at the next play. Voices end
//! by their own state (`BuffersQueued`), so no XAudio2 callback and no
//! thread of ours is involved.
//!
//! **Players** are Media Foundation media engines in audio-only mode, made at
//! the first preload or play, as [`crate::native::video`]'s are. The engine
//! reports to [`Notify`] on its own threads; each notification is posted to
//! the surface's UI thread ([`crate::window::UiThread`]) and finds its
//! player again by surface key and id, with the serial of the engine it was
//! made for (so a late notification of a closed or restarted one is
//! dropped). Progress comes from a small thread that wakes that thread every
//! [`PROGRESS_INTERVAL`] while the player plays.
//!
//! Everything but the decoding and the notifications' and the ticker's
//! posts runs on the main thread, as the macOS backend's does; the events go
//! to the root of the engine (`EventKind::Audio`).

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    audio::{AudioCommand, AudioError, AudioEvent, MAX_VOICES, PROGRESS_INTERVAL, PlayerSettings},
    image::ImageData,
};
use nsh_engine::EngineControl;
use windows::{
    Win32::{
        Foundation::E_FAIL,
        Media::{
            Audio::{
                AudioCategory_GameEffects, WAVEFORMATEX,
                XAudio2::{
                    IXAudio2, IXAudio2MasteringVoice, IXAudio2SourceVoice, IXAudio2VoiceCallback,
                    XAUDIO2_BUFFER, XAUDIO2_USE_DEFAULT_PROCESSOR, XAUDIO2_VOICE_NOSAMPLESPLAYED,
                    XAUDIO2_VOICE_STATE, XAudio2CreateWithVersionInfo,
                },
            },
            MediaFoundation::{
                CLSID_MFMediaEngineClassFactory, IMFAttributes, IMFMediaEngine,
                IMFMediaEngineClassFactory, IMFMediaEngineNotify, IMFMediaEngineNotify_Impl,
                IMFSample, MF_BYTESTREAM_ORIGIN_NAME, MF_MEDIA_ENGINE_AUDIOONLY,
                MF_MEDIA_ENGINE_CALLBACK, MF_MEDIA_ENGINE_EVENT,
                MF_MEDIA_ENGINE_EVENT_BUFFERINGENDED, MF_MEDIA_ENGINE_EVENT_BUFFERINGSTARTED,
                MF_MEDIA_ENGINE_EVENT_CANPLAY, MF_MEDIA_ENGINE_EVENT_ENDED,
                MF_MEDIA_ENGINE_EVENT_ERROR, MF_MEDIA_ENGINE_EVENT_LOADEDMETADATA,
                MF_MEDIA_ENGINE_EVENT_PLAYING, MF_MEDIA_ENGINE_EVENT_WAITING,
                MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_MAJOR_TYPE,
                MF_MT_SUBTYPE, MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
                MF_SOURCE_READERF_ENDOFSTREAM, MF_VERSION, MFAudioFormat_Float, MFCreateAttributes,
                MFCreateMFByteStreamOnStream, MFCreateMediaType,
                MFCreateSourceReaderFromByteStream, MFMediaType_Audio, MFSTARTUP_FULL, MFStartup,
            },
        },
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        },
        UI::Shell::SHCreateMemStream,
    },
    core::{BSTR, HSTRING, Interface, PCWSTR, Result, implement},
};

use crate::{image::AssetBase, native, surface::Surface};

/// What XAudio2 may be asked to do to a voice's pitch: the highest ratio a
/// voice is made for (a play's rate is at most 2).
const MAX_FREQUENCY_RATIO: f32 = 4.0;

/// One engine's sounds and players.
#[derive(Default)]
pub(crate) struct Speaker {
    inner: RefCell<Inner>,
}

#[derive(Default)]
struct Inner {
    sounds: HashMap<u32, Decoded>,
    /// Sounds decoding: one unloaded meanwhile is dropped when it is
    /// decoded.
    loading: HashSet<u32>,
    /// Before the engine: the voices go before the mastering voice.
    voices: Vec<Voice>,
    /// Made at the first play.
    engine: Option<Output>,
    players: HashMap<u32, Rc<Player>>,
}

/// The channels and sample rate of a sound's decoded audio, which a voice
/// plays only in the format it was made for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Format {
    channels: u16,
    rate: u32,
}

/// A sound decoded into memory: interleaved 32-bit float samples.
struct Decoded {
    samples: Arc<Vec<f32>>,
    format: Format,
}

/// The XAudio2 engine and its mastering voice (the output).
struct Output {
    xaudio: IXAudio2,
    mastering: IXAudio2MasteringVoice,
}

impl Drop for Output {
    fn drop(&mut self) {
        // SAFETY: the voices made on it were destroyed first (`Inner`'s
        // field order and `shutdown`); the voice is not used afterwards.
        unsafe { self.mastering.DestroyVoice() };
    }
}

/// A source voice, and the sound it plays.
struct Voice {
    source: IXAudio2SourceVoice,
    format: Format,
    /// The sound it plays, until it stops or its buffer ends.
    sound: Option<u32>,
    started: Instant,
    /// The decoded audio the submitted buffer points into, kept until the
    /// voice plays something else or is destroyed.
    keep: Option<Arc<Vec<f32>>>,
}

impl Drop for Voice {
    fn drop(&mut self) {
        // SAFETY: the voice is destroyed once, here; it is not used
        // afterwards. `keep` drops after this, so XAudio2 no longer reads
        // the buffer.
        unsafe { self.source.DestroyVoice() };
    }
}

impl Voice {
    fn new(output: &Output, format: Format, now: Instant) -> Option<Voice> {
        let bytes_per_frame = format.channels * 4;
        let wave = WAVEFORMATEX {
            wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
            nChannels: format.channels,
            nSamplesPerSec: format.rate,
            nAvgBytesPerSec: format.rate * u32::from(bytes_per_frame),
            nBlockAlign: bytes_per_frame,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        let mut source: Option<IXAudio2SourceVoice> = None;
        // SAFETY: `wave` and the out pointer are valid for the call; there
        // is no callback, no send list and no effect chain.
        let made = unsafe {
            output.xaudio.CreateSourceVoice(
                &mut source,
                &wave,
                0,
                MAX_FREQUENCY_RATIO,
                None::<&IXAudio2VoiceCallback>,
                None,
                None,
            )
        };
        if let Err(err) = made {
            log::warn!("audio: cannot make a voice: {err}");
            return None;
        }
        Some(Voice {
            source: source?,
            format,
            sound: None,
            started: now,
            keep: None,
        })
    }

    /// Whether it plays nothing (its buffer ended, or it was stopped).
    fn idle(&self) -> bool {
        if self.sound.is_none() {
            return true;
        }
        let mut state = XAUDIO2_VOICE_STATE::default();
        // SAFETY: a call on a live voice with an out pointer to a local.
        unsafe {
            self.source
                .GetState(&mut state, XAUDIO2_VOICE_NOSAMPLESPLAYED)
        };
        state.BuffersQueued == 0
    }

    /// Stops it and drops what it had queued.
    fn halt(&mut self) {
        // SAFETY: calls on a live voice.
        unsafe {
            let _ = self.source.Stop(0, 0);
            let _ = self.source.FlushSourceBuffers();
        }
        self.sound = None;
    }
}

impl Inner {
    /// Drops every voice and the output: the next play makes them again.
    fn shutdown(&mut self) {
        self.voices.clear();
        self.engine = None;
    }
}

impl Drop for Speaker {
    fn drop(&mut self) {
        let inner = self.inner.get_mut();
        for player in inner.players.values() {
            player.close();
        }
        inner.shutdown();
    }
}

/// Applies `command` for the engine `control` reports to (the surface
/// `key`'s), `asset:/` URIs resolving against `base`. On the main thread.
pub(crate) fn command(
    speaker: &Speaker,
    key: u64,
    control: &EngineControl,
    command: &AudioCommand,
    base: Option<&AssetBase>,
) {
    let id = command.id();
    match command {
        AudioCommand::Load {
            bytes,
            hint,
            max_duration,
            ..
        } => speaker.load(key, control, id, bytes.clone(), hint.clone(), *max_duration),
        AudioCommand::LoadUrl { .. } => report(
            control,
            id,
            failed(
                AudioError::NotSupported,
                "sounds are loaded from their bytes here",
            ),
        ),
        AudioCommand::Play { volume, rate, .. } => speaker.play(id, *volume, *rate),
        AudioCommand::Stop { .. } => speaker.stop(id),
        AudioCommand::Unload { .. } => {
            speaker.stop(id);
            let mut inner = speaker.inner.borrow_mut();
            inner.sounds.remove(&id);
            inner.loading.remove(&id);
        }
        AudioCommand::Open { src, settings, .. } => {
            let player = Player::new(id, key, src, *settings, base, control.clone());
            speaker.inner.borrow_mut().players.insert(id, player);
        }
        AudioCommand::Close { .. } => {
            let player = speaker.inner.borrow_mut().players.remove(&id);
            if let Some(player) = player {
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

/// Work for the decoding thread.
type Job = Box<dyn FnOnce() + Send>;

/// Runs `job` on the process's decoding thread, made at the first load:
/// one thread, so many loads at once queue rather than each taking one.
/// Hands `job` back when there is no such thread.
fn decode_off_main(job: Job) -> std::result::Result<(), Job> {
    static QUEUE: OnceLock<Option<mpsc::Sender<Job>>> = OnceLock::new();
    let queue = QUEUE.get_or_init(|| {
        let (send, jobs) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("nsh-audio-decode".into())
            .spawn(move || {
                // SAFETY: COM for this thread, in the multithreaded
                // apartment Media Foundation's source reader works in; the
                // thread lives as long as the process, so it is never
                // uninitialized.
                let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                for job in jobs {
                    job();
                }
            })
            .ok()
            .map(|_| send)
    });
    match queue {
        Some(queue) => queue.send(job).map_err(|e| e.0),
        None => Err(job),
    }
}

/// Media Foundation, started once for the process (`MFStartup` counts, so
/// the video's own start is independent of this one).
fn mf_started() -> bool {
    static STARTED: OnceLock<bool> = OnceLock::new();
    *STARTED.get_or_init(|| {
        // SAFETY: process-wide startup; never shut down (the process may
        // play audio until it exits).
        match unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) } {
            Ok(()) => true,
            Err(err) => {
                log::error!("cannot start Media Foundation: {err}");
                false
            }
        }
    })
}

/// The file extension `hint` (a file name, a URL or a `data:` URI) names,
/// which Media Foundation's byte stream handlers go by when the bytes do
/// not say; `None` when it names none of the formats it plays.
fn extension(hint: &str) -> Option<&'static str> {
    let hint = hint.to_ascii_lowercase();
    let mime = hint
        .strip_prefix("data:")
        .map(|rest| rest.split([';', ',']).next().unwrap_or_default());
    let name = hint.split(['?', '#']).next().unwrap_or_default();
    let ext = name.rsplit_once('.').map_or("", |(_, ext)| ext);
    match (mime, ext) {
        (Some("audio/mpeg" | "audio/mp3"), _) | (None, "mp3") => Some("mp3"),
        (Some("audio/aac" | "audio/mp4" | "audio/x-m4a" | "audio/m4a"), _)
        | (None, "m4a" | "aac" | "mp4") => Some("m4a"),
        (Some("audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave"), _)
        | (None, "wav") => Some("wav"),
        (Some("audio/flac"), _) | (None, "flac") => Some("flac"),
        _ => None,
    }
}

fn failure(what: &str, err: windows::core::Error) -> String {
    format!("{what}: {}", err.message())
}

/// Decodes `bytes` into 32-bit float PCM, at most `max` of it: the sound
/// and its `Loaded`.
fn decode(
    bytes: &[u8],
    hint: &str,
    max: Duration,
) -> std::result::Result<(Decoded, AudioEvent), String> {
    if !mf_started() {
        return Err("Media Foundation is not available".into());
    }
    // SAFETY: Media Foundation calls on objects made here; the out pointers
    // are locals, and a locked buffer is read only until it is unlocked.
    unsafe {
        let stream =
            SHCreateMemStream(Some(bytes)).ok_or_else(|| "no memory for the sound".to_owned())?;
        let byte_stream = MFCreateMFByteStreamOnStream(&stream)
            .map_err(|e| failure("the sound cannot be read", e))?;
        // Some handlers choose by the file name: give it one.
        if let Some(ext) = extension(hint)
            && let Ok(attributes) = byte_stream.cast::<IMFAttributes>()
        {
            let _ = attributes.SetString(
                &MF_BYTESTREAM_ORIGIN_NAME,
                &HSTRING::from(format!("sound.{ext}")),
            );
        }
        let reader = MFCreateSourceReaderFromByteStream(&byte_stream, None::<&IMFAttributes>)
            .map_err(|e| failure("the sound cannot be decoded", e))?;
        let audio = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        // Only the audio (a video file's pictures are not decoded).
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
        reader
            .SetStreamSelection(audio, true)
            .map_err(|e| failure("the sound has no audio", e))?;
        let wanted = MFCreateMediaType().map_err(|e| failure("the sound cannot be decoded", e))?;
        wanted
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .and_then(|()| wanted.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float))
            .map_err(|e| failure("the sound cannot be decoded", e))?;
        reader
            .SetCurrentMediaType(audio, None, &wanted)
            .map_err(|e| failure("the sound cannot be decoded", e))?;
        let actual = reader
            .GetCurrentMediaType(audio)
            .map_err(|e| failure("the sound cannot be decoded", e))?;
        let channels = actual.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(0) as usize;
        let rate = actual
            .GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)
            .unwrap_or(0);
        if channels == 0 || rate == 0 {
            return Err("the sound has no format".into());
        }
        // XAudio2 takes plain stereo safely: of more channels, the front
        // pair plays.
        let out_channels = channels.min(2);
        let max_frames = (max.as_secs_f64() * f64::from(rate)).ceil() as usize;
        let mut samples: Vec<f32> = Vec::new();
        let mut truncated = false;
        'read: loop {
            let mut flags = 0u32;
            let mut sample: Option<IMFSample> = None;
            reader
                .ReadSample(audio, 0, None, Some(&mut flags), None, Some(&mut sample))
                .map_err(|e| failure("the sound cannot be decoded", e))?;
            if let Some(sample) = sample {
                let buffer = sample
                    .ConvertToContiguousBuffer()
                    .map_err(|e| failure("the sound cannot be decoded", e))?;
                let (mut data, mut len) = (std::ptr::null_mut::<u8>(), 0u32);
                buffer
                    .Lock(&mut data, None, Some(&mut len))
                    .map_err(|e| failure("the sound cannot be decoded", e))?;
                let floats = len as usize / 4;
                let frames = floats / channels;
                for frame in 0..frames {
                    if samples.len() / out_channels >= max_frames {
                        truncated = true;
                        break;
                    }
                    for channel in 0..out_channels {
                        let at = (frame * channels + channel) * 4;
                        samples.push(std::ptr::read_unaligned(data.add(at).cast::<f32>()));
                    }
                }
                let _ = buffer.Unlock();
                if truncated {
                    break 'read;
                }
            }
            // The end, or an error (0x1): nothing more to wait for.
            if flags & (MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 | 0x1) != 0 {
                break;
            }
        }
        let frames = samples.len() / out_channels;
        if frames == 0 {
            return Err("the sound is empty".into());
        }
        let duration = Duration::from_secs_f64(frames as f64 / f64::from(rate));
        let event = AudioEvent::Loaded {
            duration,
            bytes: (samples.len() * 4) as u64,
            truncated,
        };
        Ok((
            Decoded {
                samples: Arc::new(samples),
                format: Format {
                    channels: out_channels as u16,
                    rate,
                },
            },
            event,
        ))
    }
}

/// Makes the XAudio2 engine and its mastering voice on the default device.
fn make_output() -> Result<Output> {
    let mut xaudio: Option<IXAudio2> = None;
    // SAFETY: an out pointer to a local; 0x0A000000 is NTDDI_WIN10, the
    // version of the header the interface is declared by.
    unsafe {
        XAudio2CreateWithVersionInfo(&mut xaudio, 0, XAUDIO2_USE_DEFAULT_PROCESSOR, 0x0A00_0000)?
    };
    let xaudio = xaudio.ok_or_else(|| windows::core::Error::from_hresult(E_FAIL))?;
    let mut mastering: Option<IXAudio2MasteringVoice> = None;
    // SAFETY: an out pointer to a local; 0 channels / 0 rate take the
    // device's, and the null id is the default device.
    unsafe {
        xaudio.CreateMasteringVoice(
            &mut mastering,
            0,
            0,
            0,
            PCWSTR::null(),
            None,
            AudioCategory_GameEffects,
        )?
    };
    let mastering = mastering.ok_or_else(|| windows::core::Error::from_hresult(E_FAIL))?;
    Ok(Output { xaudio, mastering })
}

impl Speaker {
    /// Decodes sound `id` off the main thread; the surface `key`'s speaker
    /// keeps it and reports when it is decoded.
    fn load(
        &self,
        key: u64,
        control: &EngineControl,
        id: u32,
        bytes: ImageData,
        hint: String,
        max: Duration,
    ) {
        self.inner.borrow_mut().loading.insert(id);
        let control = control.clone();
        // The decoded sound goes back to the surface's UI thread, this one.
        let ui = crate::window::UiThread::current();
        let job: Job = Box::new(move || {
            let decoded = decode(&bytes, &hint, max);
            ui.invoke(move || {
                if let Some(surface) = Surface::by_key(key) {
                    surface.audio.decoded(&control, id, decoded);
                }
            });
        });
        // Without the decoding thread, here, as before it existed.
        if let Err(job) = decode_off_main(job) {
            job();
        }
    }

    /// Keeps a decoded sound, unless it was unloaded while it decoded, and
    /// reports it.
    fn decoded(
        &self,
        control: &EngineControl,
        id: u32,
        decoded: std::result::Result<(Decoded, AudioEvent), String>,
    ) {
        let mut inner = self.inner.borrow_mut();
        if !inner.loading.remove(&id) {
            return;
        }
        match decoded {
            Ok((decoded, event)) => {
                inner.sounds.insert(id, decoded);
                drop(inner);
                report(control, id, event);
            }
            Err(message) => {
                drop(inner);
                report(control, id, failed(AudioError::Decode, &message));
            }
        }
    }

    fn play(&self, id: u32, volume: f32, rate: f32) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        let Some((samples, format)) = inner.sounds.get(&id).map(|s| (s.samples.clone(), s.format))
        else {
            return;
        };
        if inner.engine.is_none() {
            match make_output() {
                Ok(output) => inner.engine = Some(output),
                Err(err) => {
                    // No device: silence.
                    log::warn!("audio: the output did not start: {err}");
                    return;
                }
            }
        }
        let Some(output) = inner.engine.as_ref() else {
            return;
        };
        let now = Instant::now();
        // The voice to play on: an idle one of the format, an idle one of
        // another (made again), a new one, or the oldest one's place.
        let voices = &mut inner.voices;
        let index = if let Some(i) = voices.iter().position(|v| v.format == format && v.idle()) {
            i
        } else if let Some(i) = voices.iter().position(Voice::idle) {
            let Some(voice) = Voice::new(output, format, now) else {
                return;
            };
            voices[i] = voice;
            i
        } else if voices.len() < MAX_VOICES {
            let Some(voice) = Voice::new(output, format, now) else {
                return;
            };
            voices.push(voice);
            voices.len() - 1
        } else {
            let oldest = (0..voices.len())
                .min_by_key(|&i| voices[i].started)
                .unwrap_or(0);
            voices[oldest].halt();
            if voices[oldest].format != format {
                let Some(voice) = Voice::new(output, format, now) else {
                    return;
                };
                voices[oldest] = voice;
            }
            oldest
        };
        let voice = &mut voices[index];
        let buffer = XAUDIO2_BUFFER {
            AudioBytes: (samples.len() * 4) as u32,
            pAudioData: samples.as_ptr().cast(),
            ..Default::default()
        };
        // SAFETY: calls on a live voice. The buffer points into `samples`,
        // which the voice keeps (below) until it plays something else or is
        // destroyed, after its buffers were flushed.
        let started = unsafe {
            let _ = voice.source.FlushSourceBuffers();
            let _ = voice.source.SetVolume(volume, 0);
            let _ = voice.source.SetFrequencyRatio(rate, 0);
            voice
                .source
                .SubmitSourceBuffer(&buffer, None)
                .and_then(|()| voice.source.Start(0, 0))
        };
        match started {
            Ok(()) => {
                voice.keep = Some(samples);
                voice.sound = Some(id);
                voice.started = now;
            }
            Err(err) => {
                // The output went away (a device change): silence now, a
                // new output at the next play.
                log::warn!("audio: a sound did not play: {err}");
                inner.shutdown();
            }
        }
    }

    fn stop(&self, id: u32) {
        let mut inner = self.inner.borrow_mut();
        for voice in inner.voices.iter_mut().filter(|v| v.sound == Some(id)) {
            voice.halt();
            voice.keep = None;
        }
    }

    /// The player `id`, for a notification.
    fn player(&self, id: u32) -> Option<Rc<Player>> {
        self.inner.borrow().players.get(&id).cloned()
    }
}

/// A player and what it reported.
struct Player {
    id: u32,
    /// The surface it belongs to (notifications find it by this).
    key: u64,
    /// What `src` resolved to (`None`: it cannot be played).
    url: Option<String>,
    /// The source is on the network.
    http: bool,
    control: EngineControl,
    settings: Cell<PlayerSettings>,
    /// Made at the first preload or play.
    engine: RefCell<Option<IMFMediaEngine>>,
    /// Bumped with every engine made and closed: notifications for another
    /// serial are stale.
    serial: Cell<u64>,
    loaded: Cell<bool>,
    failed: Cell<bool>,
    buffering: Cell<bool>,
    /// A play waits for the load.
    wants_play: Cell<bool>,
    playing: Cell<bool>,
    /// The progress ticker's generation: it stops when this moves on.
    ticks: Arc<AtomicU64>,
    ticking: Cell<bool>,
}

impl Player {
    fn new(
        id: u32,
        key: u64,
        src: &str,
        settings: PlayerSettings,
        base: Option<&AssetBase>,
        control: EngineControl,
    ) -> Rc<Player> {
        let url = native::locate(src, base).map(|location| location.url());
        let http = url
            .as_deref()
            .is_some_and(|u| u.starts_with("http://") || u.starts_with("https://"));
        let player = Rc::new(Player {
            id,
            key,
            url,
            http,
            control,
            settings: Cell::new(settings),
            engine: RefCell::new(None),
            serial: Cell::new(0),
            loaded: Cell::new(false),
            failed: Cell::new(false),
            buffering: Cell::new(false),
            wants_play: Cell::new(false),
            playing: Cell::new(false),
            ticks: Arc::new(AtomicU64::new(0)),
            ticking: Cell::new(false),
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
        self.stop_ticker();
        log::warn!(target: "js", "audio player: {message}");
        self.report(failed(error, message));
    }

    /// The media engine, made (and its source opened) the first time.
    fn engine(&self) -> Option<IMFMediaEngine> {
        if let Some(engine) = &*self.engine.borrow() {
            return Some(engine.clone());
        }
        if self.failed.get() {
            return None;
        }
        let Some(url) = self.url.as_deref() else {
            self.fail(AudioError::NotSupported, "cannot resolve the source");
            return None;
        };
        let serial = self.serial.get() + 1;
        self.serial.set(serial);
        let engine = match make_engine(self.key, self.id, serial) {
            Ok(engine) => engine,
            Err(err) => {
                self.fail(
                    AudioError::Unavailable,
                    &format!("cannot play audio: {}", err.message()),
                );
                return None;
            }
        };
        let settings = self.settings.get();
        // SAFETY: calls on the engine just made, from the thread that made it.
        unsafe {
            let _ = engine.SetVolume(f64::from(settings.volume));
            let _ = engine.SetLoop(settings.looped);
            let _ = engine.SetDefaultPlaybackRate(f64::from(settings.rate));
            if let Err(err) = engine.SetSource(&BSTR::from(url)) {
                let kind = if self.http {
                    AudioError::Network
                } else {
                    AudioError::Decode
                };
                self.fail(kind, &err.message());
                let _ = engine.Shutdown();
                return None;
            }
        }
        *self.engine.borrow_mut() = Some(engine.clone());
        Some(engine)
    }

    /// The duration, `None` while unknown or for a live stream.
    fn duration(engine: &IMFMediaEngine) -> Option<Duration> {
        // SAFETY: a call on a live engine.
        let seconds = unsafe { engine.GetDuration() };
        (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds))
    }

    fn position(engine: &IMFMediaEngine) -> Duration {
        // SAFETY: a call on a live engine.
        let seconds = unsafe { engine.GetCurrentTime() };
        if seconds.is_finite() && seconds > 0.0 {
            Duration::from_secs_f64(seconds)
        } else {
            Duration::ZERO
        }
    }

    fn start(&self, engine: &IMFMediaEngine) {
        let rate = f64::from(self.settings.get().rate);
        // SAFETY: calls on a live engine.
        unsafe {
            let _ = engine.SetDefaultPlaybackRate(rate);
            let _ = engine.SetPlaybackRate(rate);
            let _ = engine.Play();
        }
        self.playing.set(true);
        self.report(AudioEvent::Playing);
        self.start_ticker();
    }

    /// A notification of the engine, on the main thread.
    fn notified(&self, serial: u64, event: u32, param1: usize, param2: u32) {
        if serial != self.serial.get() {
            return;
        }
        let Some(engine) = self.engine.borrow().clone() else {
            return;
        };
        match MF_MEDIA_ENGINE_EVENT(event as i32) {
            MF_MEDIA_ENGINE_EVENT_LOADEDMETADATA => {
                if self.loaded.replace(true) || self.failed.get() {
                    return;
                }
                self.report(AudioEvent::Load {
                    duration: Self::duration(&engine),
                });
                if self.wants_play.replace(false) {
                    self.start(&engine);
                }
            }
            MF_MEDIA_ENGINE_EVENT_CANPLAY
            | MF_MEDIA_ENGINE_EVENT_BUFFERINGENDED
            | MF_MEDIA_ENGINE_EVENT_PLAYING => {
                if self.loaded.get() {
                    self.set_buffering(false);
                }
            }
            MF_MEDIA_ENGINE_EVENT_WAITING | MF_MEDIA_ENGINE_EVENT_BUFFERINGSTARTED => {
                if self.playing.get() && !self.failed.get() {
                    self.set_buffering(true);
                }
            }
            MF_MEDIA_ENGINE_EVENT_ENDED => self.ended(&engine),
            MF_MEDIA_ENGINE_EVENT_ERROR => {
                let message = media_error(param1 as u16, param2 as i32);
                let kind = if self.http {
                    AudioError::Network
                } else {
                    AudioError::Decode
                };
                self.set_buffering(false);
                self.fail(kind, &message);
            }
            _ => {}
        }
    }

    fn set_buffering(&self, buffering: bool) {
        if self.buffering.replace(buffering) != buffering {
            self.report(AudioEvent::Buffer { buffering });
        }
    }

    fn ended(&self, engine: &IMFMediaEngine) {
        if self.settings.get().looped {
            // The engine loops by itself; this is only the race of a loop
            // switched on at the very end.
            // SAFETY: calls on a live engine.
            unsafe {
                let _ = engine.SetCurrentTime(0.0);
                let _ = engine.Play();
            }
            return;
        }
        self.playing.set(false);
        self.stop_ticker();
        if let Some(duration) = Self::duration(engine) {
            self.report(AudioEvent::Progress {
                position: duration,
                duration: Some(duration),
            });
        }
        self.report(AudioEvent::Ended);
    }

    fn apply(&self, command: &AudioCommand) {
        match command {
            AudioCommand::Preload { .. } => {
                let _ = self.engine();
            }
            AudioCommand::Resume { .. } => {
                if self.failed.get() {
                    // Retries from scratch.
                    self.close();
                    self.failed.set(false);
                    self.loaded.set(false);
                }
                let Some(engine) = self.engine() else { return };
                if self.loaded.get() {
                    if !self.playing.get() {
                        // SAFETY: calls on a live engine.
                        let at_end = unsafe { engine.IsEnded().as_bool() }
                            || Self::duration(&engine)
                                .is_some_and(|d| Self::position(&engine) >= d);
                        if at_end {
                            // SAFETY: as above.
                            let _ = unsafe { engine.SetCurrentTime(0.0) };
                        }
                    }
                    self.start(&engine);
                } else {
                    self.wants_play.set(true);
                }
            }
            AudioCommand::Pause { .. } => {
                self.wants_play.set(false);
                if let Some(engine) = &*self.engine.borrow() {
                    // SAFETY: a call on a live engine.
                    let _ = unsafe { engine.Pause() };
                }
                self.stop_ticker();
                if self.playing.replace(false) {
                    self.report(AudioEvent::Paused);
                }
            }
            AudioCommand::Seek { position, .. } => {
                let Some(engine) = self.engine() else { return };
                let duration = Self::duration(&engine);
                let position = duration.map_or(*position, |d| (*position).min(d));
                // SAFETY: a call on a live engine.
                let _ = unsafe { engine.SetCurrentTime(position.as_secs_f64()) };
                self.report(AudioEvent::Progress { position, duration });
            }
            AudioCommand::Set { settings, .. } => {
                self.settings.set(*settings);
                if let Some(engine) = &*self.engine.borrow() {
                    // SAFETY: calls on a live engine.
                    unsafe {
                        let _ = engine.SetVolume(f64::from(settings.volume));
                        let _ = engine.SetLoop(settings.looped);
                        let _ = engine.SetDefaultPlaybackRate(f64::from(settings.rate));
                        if self.playing.get() {
                            let _ = engine.SetPlaybackRate(f64::from(settings.rate));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// Stops the player and shuts its engine down.
    fn close(&self) {
        self.serial.set(self.serial.get() + 1);
        self.stop_ticker();
        if let Some(engine) = self.engine.borrow_mut().take() {
            // SAFETY: calls on a live engine; it is not used afterwards.
            unsafe {
                let _ = engine.Pause();
                let _ = engine.Shutdown();
            }
        }
        self.playing.set(false);
        self.wants_play.set(false);
        self.buffering.set(false);
    }

    /// Wakes the main thread every [`PROGRESS_INTERVAL`] (until stopped)
    /// to report the position.
    fn start_ticker(&self) {
        if self.ticking.replace(true) {
            return;
        }
        let generation = self.ticks.fetch_add(1, Ordering::AcqRel) + 1;
        let ticks = self.ticks.clone();
        let (key, id) = (self.key, self.id);
        // The surface's UI thread, where the ticks are reported.
        let ui = crate::window::UiThread::current();
        let spawned = std::thread::Builder::new()
            .name("nsh-audio-progress".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(PROGRESS_INTERVAL);
                    if ticks.load(Ordering::Acquire) != generation {
                        return;
                    }
                    ui.invoke(move || {
                        let Some(surface) = Surface::by_key(key) else {
                            return;
                        };
                        if let Some(player) = surface.audio.player(id) {
                            player.tick();
                        }
                    });
                }
            });
        if spawned.is_err() {
            self.ticking.set(false);
        }
    }

    fn stop_ticker(&self) {
        if self.ticking.replace(false) {
            self.ticks.fetch_add(1, Ordering::AcqRel);
        }
    }

    /// One progress report, while the player plays.
    fn tick(&self) {
        if !self.playing.get() || !self.loaded.get() {
            return;
        }
        let Some(engine) = self.engine.borrow().clone() else {
            return;
        };
        self.report(AudioEvent::Progress {
            position: Self::position(&engine),
            duration: Self::duration(&engine),
        });
    }
}

/// What a media engine error means, for the event's message.
fn media_error(code: u16, hr: i32) -> String {
    let what = match code {
        1 => "Loading was aborted.",
        2 => "A network error stopped the download.",
        3 => "The audio cannot be decoded.",
        4 => "The source cannot be played (unsupported format, or not found).",
        5 => "The audio is encrypted.",
        _ => "The audio cannot be played.",
    };
    if hr == 0 {
        what.to_owned()
    } else {
        format!("{what} (0x{:08X})", hr as u32)
    }
}

/// An audio-only media engine reporting to a [`Notify`] for player `id` of
/// surface `key`, engine `serial`.
fn make_engine(key: u64, id: u32, serial: u64) -> Result<IMFMediaEngine> {
    if !mf_started() {
        return Err(windows::core::Error::from_hresult(E_FAIL));
    }
    // Made on the surface's UI thread, where the events are handled.
    let ui = crate::window::UiThread::current();
    let notify: IMFMediaEngineNotify = Notify {
        key,
        id,
        serial,
        ui,
    }
    .into();
    // SAFETY: COM calls with valid attributes; the factory needs Media
    // Foundation started (above).
    unsafe {
        let mut attributes: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attributes, 1)?;
        let attributes = attributes.ok_or_else(|| windows::core::Error::from_hresult(E_FAIL))?;
        attributes.SetUnknown(&MF_MEDIA_ENGINE_CALLBACK, &notify)?;
        let factory: IMFMediaEngineClassFactory =
            CoCreateInstance(&CLSID_MFMediaEngineClassFactory, None, CLSCTX_INPROC_SERVER)?;
        factory.CreateInstance(MF_MEDIA_ENGINE_AUDIOONLY.0 as u32, &attributes)
    }
}

/// Receives the media engine's notifications (on Media Foundation's
/// threads) and posts them to the main thread.
#[implement(IMFMediaEngineNotify)]
struct Notify {
    key: u64,
    id: u32,
    serial: u64,
    ui: crate::window::UiThread,
}

impl IMFMediaEngineNotify_Impl for Notify_Impl {
    fn EventNotify(&self, event: u32, param1: usize, param2: u32) -> Result<()> {
        let (key, id, serial) = (self.key, self.id, self.serial);
        self.ui.invoke(move || {
            let Some(surface) = Surface::by_key(key) else {
                return;
            };
            if let Some(player) = surface.audio.player(id) {
                player.notified(serial, event, param1, param2);
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, time::Duration};

    use super::{AudioEvent, decode, decode_off_main, extension};

    /// A WAV file of `millis` of a 440 Hz tone: 16-bit mono at 8 kHz.
    fn wav(millis: u32) -> Vec<u8> {
        let rate = 8_000u32;
        let frames = rate * millis / 1000;
        let data = frames * 2;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&1u16.to_le_bytes()); // mono
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data.to_le_bytes());
        for i in 0..frames {
            let t = i as f32 / rate as f32;
            let v = (t * 440.0 * std::f32::consts::TAU).sin() * 8_000.0;
            out.extend_from_slice(&(v as i16).to_le_bytes());
        }
        out
    }

    #[test]
    fn a_sound_decodes_on_the_decoding_thread() {
        let (send, receive) = mpsc::channel();
        let bytes = wav(250);
        let queued = decode_off_main(Box::new(move || {
            let decoded =
                decode(&bytes, "click.wav", Duration::from_secs(5)).map(|(_, event)| event);
            let _ = send.send((std::thread::current().id(), decoded));
        }));
        assert!(queued.is_ok(), "no decoding thread");
        let (thread, decoded) = receive
            .recv_timeout(Duration::from_secs(10))
            .expect("the decoding thread answers");
        assert_ne!(thread, std::thread::current().id());
        match decoded {
            Ok(AudioEvent::Loaded {
                duration,
                truncated,
                ..
            }) => {
                assert!(
                    duration.abs_diff(Duration::from_millis(250)) < Duration::from_millis(20),
                    "{duration:?}"
                );
                assert!(!truncated);
            }
            // A Windows without Media Foundation (Server Core, N editions).
            Err(message) if message.contains("Media Foundation is not available") => {}
            other => panic!("not decoded: {other:?}"),
        }
    }

    #[test]
    fn extensions_come_from_names_and_media_types() {
        assert_eq!(extension("sounds/click.MP3"), Some("mp3"));
        assert_eq!(extension("https://a.com/x.m4a?v=2"), Some("m4a"));
        assert_eq!(extension("data:audio/mpeg;base64,AA"), Some("mp3"));
        assert_eq!(extension("data:audio/wav,%00"), Some("wav"));
        assert_eq!(extension("click"), None);
    }
}
