//! Sound for Rust components and the runtime's `Sound` / `AudioPlayer`
//! ([`crate::audio`]): loading a sound (its bytes through the image
//! loader, one decode per source per engine, the engine's limits), its
//! plays, and players.
//!
//! The limits are kept here, on the engine thread, so what JS asks never
//! raises them: [`MAX_SOUND_BYTES`](crate::audio::MAX_SOUND_BYTES) before the
//! platform sees the bytes, [`MAX_SOUNDS`](crate::audio::MAX_SOUNDS) before a
//! load starts, and the decoded length and size the platform reports.

#[cfg(not(target_arch = "wasm32"))]
use std::sync::{Arc, Mutex};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::{Rc, Weak},
    task::{Poll, Waker},
    time::Duration,
};

use super::{Action, AudioAction, Executor, ambient::executor};
#[cfg(not(target_arch = "wasm32"))]
use crate::image::loader::{self, Location, Priority};
use crate::{
    audio::{
        AudioCommand, AudioError, AudioEvent, AudioEvents, MAX_DECODED_BYTES, MAX_SOUND_BYTES,
        MAX_SOUND_DURATION, MAX_SOUNDS, PlayerSettings,
    },
    image::ImageData,
};

/// Why a sound did not load, or a player failed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct AudioFailure {
    /// What kind of failure.
    pub error: AudioError,
    /// What happened, in words.
    pub message: String,
    /// For [`AudioError::NotAllowed`]: the capability that would grant it
    /// (`audio`, `network`, `fs`), when the core refused it here.
    pub(crate) permission: Option<&'static str>,
}

impl Default for AudioFailure {
    fn default() -> Self {
        Self::new(AudioError::Failed, "")
    }
}

impl AudioFailure {
    fn new(error: AudioError, message: impl Into<String>) -> Self {
        Self {
            error,
            message: message.into(),
            permission: None,
        }
    }

    /// A refusal for want of `capability` (made where the core reads a
    /// sound itself, off the web).
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub(crate) fn refused(capability: &'static str, message: impl Into<String>) -> Self {
        Self {
            permission: Some(capability),
            ..Self::new(AudioError::NotAllowed, message)
        }
    }
}

impl std::fmt::Display for AudioFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.error.as_str())
    }
}

/// An engine's sounds: one decoded buffer per source, and what they hold.
#[derive(Default)]
pub(crate) struct Sounds {
    /// By source key: loaded (held by the [`Sound`]s over it) or loading.
    sources: HashMap<String, Source>,
    /// The decoded audio of the buffers loaded.
    decoded: u64,
}

enum Source {
    Loading(Rc<Pending>),
    Loaded(Weak<Buffer>),
}

impl Sounds {
    /// Sources loaded or loading: what [`MAX_SOUNDS`] counts.
    fn len(&self) -> usize {
        self.sources
            .values()
            .filter(|s| match s {
                Source::Loading(_) => true,
                Source::Loaded(buffer) => buffer.strong_count() > 0,
            })
            .count()
    }
}

/// A load in flight that later loads of the same source wait for.
#[derive(Default)]
struct Pending {
    result: RefCell<Option<Result<Rc<Buffer>, AudioFailure>>>,
    wakers: RefCell<Vec<Waker>>,
}

impl Pending {
    fn finish(&self, result: Result<Rc<Buffer>, AudioFailure>) {
        *self.result.borrow_mut() = Some(result);
        for waker in self.wakers.take() {
            waker.wake();
        }
    }
}

/// One decoded sound on the platform; unloaded with the last [`Sound`].
struct Buffer {
    id: u32,
    key: String,
    duration: Duration,
    bytes: u64,
    executor: Weak<Executor>,
}

impl Drop for Buffer {
    fn drop(&mut self) {
        let Some(executor) = self.executor.upgrade() else {
            return;
        };
        {
            let mut sounds = executor.sounds.borrow_mut();
            sounds.decoded = sounds.decoded.saturating_sub(self.bytes);
            if matches!(sounds.sources.get(&self.key), Some(Source::Loaded(_))) {
                sounds.sources.remove(&self.key);
            }
        }
        executor.act(Action::Audio(AudioAction::Command(AudioCommand::Unload {
            id: self.id,
        })));
    }
}

/// Whether sound plays here (TS: `Sound.available()`): the platform plays
/// sound, or the embedding app gave the core its own audio stack. To await
/// in a task.
pub fn audio_available() -> super::Answer<bool> {
    let (answer, slot) = super::Answer::new();
    executor().act(Action::Audio(AudioAction::Available(slot)));
    answer
}

/// What a sound is loaded from ([`load_sound`]; TS: `Sound.load`'s
/// `string | Uint8Array`): where its file is, or the file's bytes.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum SoundSource {
    /// A bundled asset (`asset!(...)`'s `uri`), a relative path, `file:`,
    /// `data:` or an `http(s)` URL.
    Url(String),
    /// The encoded bytes of a sound file (WAV, AAC, MP3, ...): one the app
    /// embeds (`include_bytes!`) or makes. Its format is read from the
    /// bytes; equal bytes share one decoded sound.
    Bytes(ImageData),
}

impl From<&str> for SoundSource {
    fn from(src: &str) -> Self {
        Self::Url(src.to_owned())
    }
}

impl From<&String> for SoundSource {
    fn from(src: &String) -> Self {
        Self::Url(src.clone())
    }
}

impl From<String> for SoundSource {
    fn from(src: String) -> Self {
        Self::Url(src)
    }
}

impl From<ImageData> for SoundSource {
    fn from(bytes: ImageData) -> Self {
        Self::Bytes(bytes)
    }
}

impl From<Vec<u8>> for SoundSource {
    fn from(bytes: Vec<u8>) -> Self {
        Self::Bytes(ImageData::new(bytes))
    }
}

impl From<&'static [u8]> for SoundSource {
    fn from(bytes: &'static [u8]) -> Self {
        Self::Bytes(ImageData::new(bytes))
    }
}

impl<const N: usize> From<&'static [u8; N]> for SoundSource {
    fn from(bytes: &'static [u8; N]) -> Self {
        Self::Bytes(ImageData::new(bytes.as_slice()))
    }
}

/// Loads a sound (TS: `Sound.load`), to await in a task: its bytes (read
/// from a bundled asset, a relative path, `file:`, `data:` or `http(s)`, or
/// given) decoded by the platform into memory, so [`Sound::play`] starts at
/// once. Loading a source (or bytes) this engine has loaded already shares
/// its decoded audio. Fails when the app's capabilities do not grant
/// `audio` (or `network` for a remote source), past the engine's limits
/// ([`crate::audio`]'s), when the bytes cannot be read or decoded, and
/// where nothing plays sound.
pub async fn load_sound(src: impl Into<SoundSource>) -> Result<Sound, AudioFailure> {
    let executor = executor();
    let src = src.into();
    // Before any byte is read (the core checks again, and alone on the web,
    // where the platform fetches).
    #[cfg(not(target_arch = "wasm32"))]
    let granted = {
        let context = loader::context();
        match &src {
            SoundSource::Url(src) => Some(granted_uri(
                &context.access,
                &context.media_files,
                src,
                asset_uri(src),
            )?),
            SoundSource::Bytes(_) => {
                audio_granted(&context.access)?;
                None
            }
        }
    };
    // Nothing to read for where nothing plays it.
    if !audio_available().await {
        return Err(AudioFailure::new(
            AudioError::Unavailable,
            "nothing plays sound here",
        ));
    }
    let (location, src) = match src {
        SoundSource::Url(src) => {
            // The URL the check granted: the one loaded (the web's
            // platform fetches and checks alone).
            #[cfg(not(target_arch = "wasm32"))]
            let uri = granted.unwrap_or_else(|| asset_uri(&src));
            #[cfg(target_arch = "wasm32")]
            let uri = asset_uri(&src);
            (
                locate(&uri).ok_or_else(|| {
                    AudioFailure::new(AudioError::NotSupported, format!("no sound at `{src}`"))
                })?,
                src,
            )
        }
        SoundSource::Bytes(bytes) => {
            too_big(bytes.len(), "the sound's bytes")?;
            // Named by its format and a digest of its bytes: the decoders
            // that go by a name read the format from it, and equal bytes
            // share one load.
            let name = crate::image::data_key(crate::audio::sniff(&bytes), &bytes);
            (Fetch::Bytes(bytes, name.clone()), name)
        }
    };
    let src = src.as_str();
    let key = location.key();
    // Loaded or loading already: share it.
    let existing = match executor.sounds.borrow().sources.get(&key) {
        Some(Source::Loaded(buffer)) => buffer.upgrade().map(Ok),
        Some(Source::Loading(pending)) => Some(Err(pending.clone())),
        None => None,
    };
    match existing {
        Some(Ok(buffer)) => return Ok(Sound::new(buffer)),
        Some(Err(pending)) => return wait(&pending).await.map(Sound::new),
        None => {}
    }
    if executor.sounds.borrow().len() >= MAX_SOUNDS {
        return Err(AudioFailure::new(
            AudioError::QuotaExceeded,
            format!("an app loads at most {MAX_SOUNDS} sounds at once"),
        ));
    }
    let pending = Rc::new(Pending::default());
    executor
        .sounds
        .borrow_mut()
        .sources
        .insert(key.clone(), Source::Loading(pending.clone()));
    // Ends the load for the ones waiting on it whatever happens to this
    // task, dropped included.
    let mut guard = LoadGuard {
        pending: pending.clone(),
        executor: Rc::downgrade(&executor),
        key: key.clone(),
        done: false,
    };
    let result = decode(&executor, location, key, src).await;
    guard.done = true;
    {
        let mut sounds = executor.sounds.borrow_mut();
        match &result {
            Ok(buffer) => {
                sounds
                    .sources
                    .insert(buffer.key.clone(), Source::Loaded(Rc::downgrade(buffer)));
            }
            Err(_) => {
                sounds.sources.remove(&guard.key);
            }
        }
    }
    pending.finish(result.clone());
    result.map(Sound::new)
}

/// Ends a load others wait on when its task goes before it finished.
struct LoadGuard {
    pending: Rc<Pending>,
    executor: Weak<Executor>,
    key: String,
    done: bool,
}

impl Drop for LoadGuard {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        if let Some(executor) = self.executor.upgrade() {
            executor.sounds.borrow_mut().sources.remove(&self.key);
        }
        self.pending.finish(Err(AudioFailure::new(
            AudioError::Failed,
            "the load was cancelled",
        )));
    }
}

async fn wait(pending: &Pending) -> Result<Rc<Buffer>, AudioFailure> {
    std::future::poll_fn(|cx| match &*pending.result.borrow() {
        Some(result) => Poll::Ready(result.clone()),
        None => {
            pending.wakers.borrow_mut().push(cx.waker().clone());
            Poll::Pending
        }
    })
    .await
}

/// Refuses sound to an app whose capabilities do not grant `audio`.
#[cfg(not(target_arch = "wasm32"))]
fn audio_granted(access: &crate::access::Access) -> Result<(), AudioFailure> {
    if access.allows_audio() {
        return Ok(());
    }
    Err(AudioFailure::refused(
        "audio",
        "sound is not granted: add `\"audio\": true` to capabilities in nsh.json",
    ))
}

/// What a sound loads from `uri` (`src` as the loader names it), if the app
/// may load it: the URL the check granted (`Access::media_url`).
#[cfg(not(target_arch = "wasm32"))]
fn granted_uri(
    access: &crate::access::Access,
    files: &crate::access::MediaFiles,
    src: &str,
    uri: String,
) -> Result<String, AudioFailure> {
    audio_granted(access)?;
    match access.media_url(&uri, None, Some(files)) {
        Some(std::borrow::Cow::Owned(granted)) => Ok(granted),
        Some(std::borrow::Cow::Borrowed(_)) => Ok(uri),
        None => {
            let capability = crate::access::media_capability(&uri, None);
            Err(AudioFailure::refused(
                capability,
                format!(
                    "`{src}` is not granted by capabilities.{capability}: {}",
                    crate::access::media_grant_advice(&uri, None)
                ),
            ))
        }
    }
}

/// `src` as the loader names it: a relative path is the app's asset.
fn asset_uri(src: &str) -> String {
    let has_scheme = src
        .split_once(':')
        .is_some_and(|(scheme, _)| !scheme.is_empty() && !scheme.contains('/'));
    if has_scheme || src.starts_with('/') {
        src.to_owned()
    } else {
        format!("asset:/{}", src.trim_start_matches("./"))
    }
}

/// Where a sound's bytes come from.
enum Fetch {
    /// Read here, through the image loader.
    #[cfg(not(target_arch = "wasm32"))]
    Read(Location),
    /// A `data:` URI's bytes, decoded here.
    Data(String),
    /// Bytes the app gave, and the name they go by.
    Bytes(ImageData, String),
    /// Fetched by the platform from this URL (an `asset:/` URI or an
    /// `http(s)` URL the core checked): the web, where the browser fetches
    /// and the image loader has no threads.
    #[cfg(target_arch = "wasm32")]
    Url(String),
}

impl Fetch {
    fn key(&self) -> String {
        match self {
            #[cfg(not(target_arch = "wasm32"))]
            Fetch::Read(location) => location.key(),
            Fetch::Data(uri) => uri.clone(),
            Fetch::Bytes(_, name) => name.clone(),
            #[cfg(target_arch = "wasm32")]
            Fetch::Url(url) => url.clone(),
        }
    }
}

/// Where `uri`'s bytes come from: inline bytes are decoded everywhere,
/// other sources read by the image loader, or on the web fetched by the
/// browser.
fn locate(uri: &str) -> Option<Fetch> {
    if uri.starts_with("data:") {
        return Some(Fetch::Data(uri.to_owned()));
    }
    #[cfg(target_arch = "wasm32")]
    return Some(Fetch::Url(uri.to_owned()));
    #[cfg(not(target_arch = "wasm32"))]
    loader::context().resolve(uri).map(Fetch::Read)
}

/// Refuses encoded bytes past [`MAX_SOUND_BYTES`]; `what` names them.
fn too_big(len: usize, what: &str) -> Result<(), AudioFailure> {
    if len > MAX_SOUND_BYTES {
        return Err(AudioFailure::new(
            AudioError::QuotaExceeded,
            format!("{what} is {len} bytes: a sound is at most {MAX_SOUND_BYTES}"),
        ));
    }
    Ok(())
}

/// Has the platform decode the sound (its bytes read here first, or
/// fetched by the platform) and checks what it reports against the
/// engine's limits.
async fn decode(
    executor: &Rc<Executor>,
    fetch: Fetch,
    key: String,
    src: &str,
) -> Result<Rc<Buffer>, AudioFailure> {
    let id = crate::audio::ids();
    let fetch_url = match &fetch {
        #[cfg(target_arch = "wasm32")]
        Fetch::Url(url) => url.clone(),
        _ => String::new(),
    };
    let bytes = match fetch {
        #[cfg(not(target_arch = "wasm32"))]
        Fetch::Read(location) => Some(read(location).await?),
        Fetch::Data(uri) => Some(
            crate::image::decode_data_uri(&uri)
                .map(|(_, bytes)| ImageData::from(bytes))
                .map_err(|message| AudioFailure::new(AudioError::NotSupported, message))?,
        ),
        Fetch::Bytes(bytes, _) => Some(bytes),
        #[cfg(target_arch = "wasm32")]
        Fetch::Url(_) => None,
    };
    let command = match (bytes, fetch_url) {
        (Some(bytes), _) => {
            too_big(bytes.len(), &format!("`{src}`"))?;
            AudioCommand::Load {
                id,
                bytes,
                hint: src.to_owned(),
                max_duration: MAX_SOUND_DURATION,
            }
        }
        (None, url) => AudioCommand::LoadUrl {
            id,
            url,
            max_bytes: MAX_SOUND_BYTES,
            max_duration: MAX_SOUND_DURATION,
        },
    };
    let (sink, mut events) = crate::audio::channel();
    executor.act(Action::Audio(AudioAction::Open { command, sink }));
    let unload = || {
        executor.act(Action::Audio(AudioAction::Command(AudioCommand::Unload {
            id,
        })));
    };
    let event = std::future::poll_fn(|cx| events.poll_next(cx)).await;
    match event {
        Some(AudioEvent::Loaded {
            duration,
            bytes,
            truncated,
        }) => {
            if truncated || duration > MAX_SOUND_DURATION {
                unload();
                return Err(AudioFailure::new(
                    AudioError::QuotaExceeded,
                    format!(
                        "`{src}` is longer than {} s: play it with an AudioPlayer",
                        MAX_SOUND_DURATION.as_secs()
                    ),
                ));
            }
            let mut sounds = executor.sounds.borrow_mut();
            if sounds.decoded + bytes > MAX_DECODED_BYTES {
                drop(sounds);
                unload();
                return Err(AudioFailure::new(
                    AudioError::QuotaExceeded,
                    format!(
                        "the sounds loaded would take more than {MAX_DECODED_BYTES} bytes decoded"
                    ),
                ));
            }
            sounds.decoded += bytes;
            Ok(Rc::new(Buffer {
                id,
                key,
                duration,
                bytes,
                executor: Rc::downgrade(executor),
            }))
        }
        Some(AudioEvent::Failed { error, message }) => {
            unload();
            Err(AudioFailure::new(error, message))
        }
        Some(other) => {
            unload();
            Err(AudioFailure::new(
                AudioError::Failed,
                format!("the platform answered a load with {other:?}"),
            ))
        }
        // The core refused it: the sink said why before it closed.
        None => Err(AudioFailure::new(
            AudioError::Failed,
            "the sound did not load",
        )),
    }
}

/// `location`'s bytes through the image loader (its limits, cache and
/// redirect checks), read on its threads.
#[cfg(not(target_arch = "wasm32"))]
async fn read(location: Location) -> Result<ImageData, AudioFailure> {
    type Slot = Arc<Mutex<(Option<Result<ImageData, String>>, Option<Waker>)>>;
    let slot: Slot = Arc::default();
    let remote = matches!(location, Location::Url(_));
    let context = loader::context();
    let ticket = loader::loader().read(location, &context, Priority::Normal, None, {
        let slot = slot.clone();
        Box::new(move |result| {
            let waker = {
                let mut slot = slot.lock().expect("sound read");
                slot.0 = Some(result);
                slot.1.take()
            };
            if let Some(waker) = waker {
                waker.wake();
            }
        })
    });
    let result = std::future::poll_fn(|cx| {
        let mut slot = slot.lock().expect("sound read");
        match slot.0.take() {
            Some(result) => Poll::Ready(result),
            None => {
                slot.1 = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    })
    .await;
    drop(ticket);
    result.map_err(|message| {
        let error = if remote {
            AudioError::Network
        } else {
            AudioError::NotSupported
        };
        AudioFailure::new(error, message)
    })
}

/// A sound loaded into memory ([`load_sound`]): play it any number of
/// times, overlapping. Its decoded audio is freed with the last `Sound`
/// over its source.
#[derive(Clone)]
pub struct Sound {
    buffer: Rc<Buffer>,
}

impl std::fmt::Debug for Sound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sound")
            .field("id", &self.buffer.id)
            .field("duration", &self.buffer.duration)
            .finish()
    }
}

impl Sound {
    fn new(buffer: Rc<Buffer>) -> Self {
        Self { buffer }
    }

    /// How long it plays.
    pub fn duration(&self) -> Duration {
        self.buffer.duration
    }

    /// Plays it over the voices playing, at `volume` (0 to 1) and `rate`
    /// (0.5 to 2), clamped. Nothing is reported: a muted device or a voice
    /// the platform drops is silence, not an error.
    pub fn play(&self, volume: f32, rate: f32) {
        let volume = if volume.is_nan() {
            1.0
        } else {
            volume.clamp(0.0, 1.0)
        };
        let rate = if rate.is_nan() {
            1.0
        } else {
            rate.clamp(0.5, 2.0)
        };
        self.act(AudioCommand::Play {
            id: self.buffer.id,
            volume,
            rate,
        });
    }

    /// Stops every voice of it.
    pub fn stop(&self) {
        self.act(AudioCommand::Stop { id: self.buffer.id });
    }

    fn act(&self, command: AudioCommand) {
        if let Some(executor) = self.buffer.executor.upgrade() {
            executor.act(Action::Audio(AudioAction::Command(command)));
        }
    }
}

/// Where a player is ([`AudioPlayer::state`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum PlayerState {
    /// Nothing asked yet, or failed and waiting to be told again.
    #[default]
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

/// A player of long audio (TS: `AudioPlayer`; [`audio_player`]): streamed
/// from its source as it plays. Closed when dropped.
pub struct AudioPlayer {
    id: u32,
    events: AudioEvents,
    executor: Weak<Executor>,
    settings: Cell<PlayerSettings>,
}

impl std::fmt::Debug for AudioPlayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioPlayer")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// Makes a player of `src` (a bundled asset, a relative path, `file:` or
/// `http(s)`), loading nothing until [`AudioPlayer::play`] or
/// [`AudioPlayer::preload`]. Its events come from [`AudioPlayer::next`];
/// the first is [`AudioEvent::Failed`] (and then nothing) when the app's
/// capabilities do not grant `audio` or the source, or where nothing plays
/// sound.
pub fn audio_player(src: &str, settings: PlayerSettings) -> AudioPlayer {
    let executor = executor();
    let id = crate::audio::ids();
    let (sink, events) = crate::audio::channel();
    executor.act(Action::Audio(AudioAction::Open {
        command: AudioCommand::Open {
            id,
            src: asset_uri(src),
            settings,
        },
        sink,
    }));
    AudioPlayer {
        id,
        events,
        executor: Rc::downgrade(&executor),
        settings: Cell::new(settings),
    }
}

impl AudioPlayer {
    /// Its next event; `None` once it is closed.
    pub async fn next(&mut self) -> Option<AudioEvent> {
        std::future::poll_fn(|cx| self.poll_next(cx)).await
    }

    /// Polls for its next event ([`Self::next`]).
    pub fn poll_next(&mut self, cx: &mut std::task::Context<'_>) -> Poll<Option<AudioEvent>> {
        self.events.poll_next(cx)
    }

    /// Plays from where it is, loading first if needed.
    pub fn play(&self) {
        self.act(AudioCommand::Resume { id: self.id });
    }

    /// Starts loading without playing.
    pub fn preload(&self) {
        self.act(AudioCommand::Preload { id: self.id });
    }

    /// Pauses.
    pub fn pause(&self) {
        self.act(AudioCommand::Pause { id: self.id });
    }

    /// Moves to `position` (clamped to its duration).
    pub fn seek(&self, position: Duration) {
        self.act(AudioCommand::Seek {
            id: self.id,
            position,
        });
    }

    /// Its settings.
    pub fn settings(&self) -> PlayerSettings {
        self.settings.get()
    }

    /// Changes its settings (volume and rate clamped to their ranges).
    pub fn set_settings(&self, mut settings: PlayerSettings) {
        settings.volume = settings.volume.clamp(0.0, 1.0);
        settings.rate = settings.rate.clamp(0.5, 2.0);
        if settings == self.settings.get() {
            return;
        }
        self.settings.set(settings);
        self.act(AudioCommand::Set {
            id: self.id,
            settings,
        });
    }

    /// Stops it and frees what plays it; nothing comes after.
    pub fn close(&self) {
        self.act(AudioCommand::Close { id: self.id });
    }

    fn act(&self, command: AudioCommand) {
        if let Some(executor) = self.executor.upgrade() {
            executor.act(Action::Audio(AudioAction::Command(command)));
        }
    }
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::asset_uri;

    #[test]
    fn relative_paths_are_assets() {
        assert_eq!(asset_uri("sounds/click.wav"), "asset:/sounds/click.wav");
        assert_eq!(asset_uri("./click.wav"), "asset:/click.wav");
        assert_eq!(asset_uri("asset:/click.wav"), "asset:/click.wav");
        assert_eq!(asset_uri("https://a.com/x.mp3"), "https://a.com/x.mp3");
        assert_eq!(
            asset_uri("data:audio/wav;base64,AA"),
            "data:audio/wav;base64,AA"
        );
        assert_eq!(asset_uri("/tmp/x.wav"), "/tmp/x.wav");
    }

    /// A sound loads the URL the check granted, as WHATWG's parser reads
    /// the source.
    #[test]
    fn sounds_load_the_url_the_check_granted() {
        use super::granted_uri;
        let access = crate::access::Access {
            declared: crate::access::Capabilities::from_json(&serde_json::json!({
                "audio": true,
                "network": { "http": [{ "host": "example.com", "pathPrefix": "/public" }] }
            }))
            .unwrap(),
            granted: None,
        };
        let files = crate::access::MediaFiles::default();
        let load =
            |src: &str| granted_uri(&access, &files, src, asset_uri(src)).map_err(|f| f.error);
        assert_eq!(
            load("https://EXAMPLE.com/private/../public/a.wav"),
            Ok("https://example.com/public/a.wav".to_owned())
        );
        assert!(load("https://example.com/public/../private/a.wav").is_err());
        assert!(load("https://example.com/public/%2e%2e/private/a.wav").is_err());
        assert!(load("//example.com/public/a.wav").is_err());
        assert_eq!(load("click.wav"), Ok("asset:/click.wav".to_owned()));
    }

    /// A local sound is read under `capabilities.fs.read`, and a refusal
    /// says so.
    #[cfg(unix)]
    #[test]
    fn local_sounds_need_an_fs_read_grant() {
        use super::granted_uri;
        let base =
            std::env::var_os("TMPDIR").map_or_else(std::env::temp_dir, std::path::PathBuf::from);
        let dir = base.join(format!("sound-files-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sounds")).unwrap();
        let dir = crate::access::canonicalize(&dir).unwrap();
        let sounds = dir.join("sounds").to_str().unwrap().to_owned();
        let access = crate::access::Access {
            declared: crate::access::Capabilities::from_json(
                &serde_json::json!({ "audio": true, "fs": { "read": [sounds.clone()] } }),
            )
            .unwrap(),
            granted: None,
        };
        let files = crate::access::MediaFiles::new(
            &access,
            None,
            &crate::access::TrustedPaths::default(),
            true,
        );
        let load = |src: &str| granted_uri(&access, &files, src, asset_uri(src));
        assert_eq!(
            load(&format!("{sounds}/x/../a.wav")).ok(),
            Some(format!("{sounds}/a.wav"))
        );
        let refused = load(&format!("{sounds}/../b.wav")).unwrap_err();
        assert!(
            refused.message.contains("capabilities.fs"),
            "{}",
            refused.message
        );
        // A relative path is a bundled file, which stays in the app's files.
        assert_eq!(
            load("sfx/click.wav").ok(),
            Some("asset:/sfx/click.wav".to_owned())
        );
        assert!(load("../outside.wav").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
