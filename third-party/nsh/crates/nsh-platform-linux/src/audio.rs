//! Audio on Linux (`Command::Audio`, `nsh`'s `Sound` and `AudioPlayer`),
//! through GTK's media support (`gtk::MediaFile`, which GTK backs with
//! GStreamer), as the video does: no other media crate is linked.
//!
//! - **Sounds** are [`crate::sound`]'s: decoded once into memory with
//!   GStreamer off the main thread at [`AudioCommand::Load`], and played
//!   from there through one mixing pipeline per engine, overlapping, at
//!   their volume and rate.
//! - **Players** are one `MediaFile` each, made at the first preload or
//!   resume, which streams its source (a file, an `http(s)` URL).
//! - GTK streams have no playback rate: a player's `rate` is ignored
//!   (warned once). They report no buffering either: a player waiting for its load
//!   reports `Buffer` from the resume to the load.
//! - Everything but the decoding runs on the GTK main loop. An output or a
//!   decoder that is missing makes a sound silence and a player `Failed`,
//!   never a panic.

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use gtk4::{self as gtk, gio, glib, prelude::*};
use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    audio::{AudioCommand, AudioError, AudioEvent, PROGRESS_INTERVAL, PlayerSettings},
};
use nsh_engine::EngineControl;

use crate::{image::AssetBase, sound};

/// How long a player's stream has to prepare, six times over, before it
/// is called failed.
const PREPARE_TIMEOUT: Duration = Duration::from_secs(10);

/// One engine's sounds and players.
#[derive(Default)]
pub(crate) struct Speaker {
    /// Shared with the decodes in flight, which find it again (or not:
    /// the surface closed) when they finish.
    inner: Rc<RefCell<Inner>>,
}

#[derive(Default)]
struct Inner {
    sounds: HashMap<u32, sound::Pcm>,
    /// The sounds decoding; an unload before the decode finished takes
    /// the id out, and the decoded sound is dropped.
    loading: HashSet<u32>,
    /// Made at the first play, again after the output failed.
    mixer: Option<sound::Mixer>,
    players: HashMap<u32, Rc<Player>>,
}

impl Drop for Speaker {
    fn drop(&mut self) {
        let inner = self.inner.borrow();
        for player in inner.players.values() {
            player.close();
        }
    }
}

/// Applies `command` for the engine `control` reports to, `asset:/` URIs
/// resolving against `base`. On the main thread.
pub(crate) fn command(
    speaker: &Speaker,
    control: &EngineControl,
    command: &AudioCommand,
    base: Option<&AssetBase>,
) {
    let id = command.id();
    match command {
        AudioCommand::Load {
            bytes,
            max_duration,
            ..
        } => speaker.load(control, id, bytes.to_vec(), *max_duration),
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
            let player = Player::new(id, src, *settings, base, control.clone());
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

/// GTK's media streams have no rate: said once.
fn warn_rate(rate: f32) {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if (rate - 1.0).abs() > f32::EPSILON && !WARNED.swap(true, Ordering::Relaxed) {
        log::warn!(target: "js", "an AudioPlayer's `rate` is not supported on Linux: it plays at 1×");
    }
}

/// A stream's microseconds as a duration; `None` when unknown (0).
fn micros(us: i64) -> Option<Duration> {
    (us > 0).then(|| Duration::from_micros(us as u64))
}

impl Speaker {
    /// Decodes `bytes` off the main thread, then keeps the sound and
    /// reports its load, unless it was unloaded (or the surface closed) in
    /// the meantime.
    fn load(&self, control: &EngineControl, id: u32, bytes: Vec<u8>, max: Duration) {
        self.inner.borrow_mut().loading.insert(id);
        let decoding = gio::spawn_blocking(move || sound::decode(bytes, max));
        let speaker = Rc::downgrade(&self.inner);
        let control = control.clone();
        glib::spawn_future_local(async move {
            let decoded = decoding
                .await
                .unwrap_or_else(|_| Err("the decoder stopped".into()));
            let Some(inner) = speaker.upgrade() else {
                return;
            };
            let mut inner = inner.borrow_mut();
            if !inner.loading.remove(&id) {
                return;
            }
            match decoded {
                Ok(decoded) => {
                    let event = AudioEvent::Loaded {
                        duration: decoded.duration,
                        bytes: decoded.pcm.bytes(),
                        truncated: decoded.truncated,
                    };
                    inner.sounds.insert(id, decoded.pcm);
                    drop(inner);
                    report(&control, id, event);
                }
                Err(sound::Failure::Unsupported(message)) => {
                    drop(inner);
                    report(&control, id, failed(AudioError::NotSupported, &message));
                }
                Err(sound::Failure::Other(message)) => {
                    drop(inner);
                    report(&control, id, failed(AudioError::Decode, &message));
                }
            }
        });
    }

    /// Plays a sound loaded; without an output, nothing (the sound is
    /// silence).
    fn play(&self, id: u32, volume: f32, rate: f32) {
        let mut inner = self.inner.borrow_mut();
        let Some(pcm) = inner.sounds.get(&id).cloned() else {
            return;
        };
        if inner.mixer.as_ref().is_some_and(sound::Mixer::is_broken) {
            inner.mixer = None;
        }
        if inner.mixer.is_none() {
            match sound::Mixer::new() {
                Ok(mixer) => inner.mixer = Some(mixer),
                Err(e) => {
                    log::warn!("no sound output: {e}");
                    return;
                }
            }
        }
        if let Some(mixer) = inner.mixer.as_mut()
            && let Err(e) = mixer.play(id, &pcm, volume, rate)
        {
            log::warn!("a sound did not play: {e}");
        }
    }

    fn stop(&self, id: u32) {
        if let Some(mixer) = self.inner.borrow_mut().mixer.as_mut() {
            mixer.stop(id);
        }
    }
}

/// A player and what it reported.
struct Player {
    id: u32,
    file: Option<gio::File>,
    /// Whether the source is an `http(s)` URL (its failures are the
    /// network's).
    network: bool,
    control: EngineControl,
    settings: Cell<PlayerSettings>,
    /// Made at the first preload or play.
    stream: RefCell<Option<gtk::MediaFile>>,
    handlers: RefCell<Vec<glib::SignalHandlerId>>,
    progress: RefCell<Option<glib::SourceId>>,
    loaded: Cell<bool>,
    failed: Cell<bool>,
    buffering: Cell<bool>,
    /// A play waits for the load.
    wants_play: Cell<bool>,
    /// A seek waits for the load: GTK seeks only a prepared stream.
    seek_to: Cell<Option<Duration>>,
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
        let file = locate(src, base);
        let player = Rc::new(Player {
            id,
            network: src.starts_with("http://")
                || src.starts_with("https://")
                || (src.starts_with("asset:/") && matches!(base, Some(AssetBase::Http(_)))),
            file,
            control,
            settings: Cell::new(settings),
            stream: RefCell::default(),
            handlers: RefCell::default(),
            progress: RefCell::default(),
            loaded: Cell::new(false),
            failed: Cell::new(false),
            buffering: Cell::new(false),
            wants_play: Cell::new(false),
            seek_to: Cell::new(None),
            playing: Cell::new(false),
        });
        if player.file.is_none() {
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
        self.set_buffering(false);
        self.report(failed(error, message));
    }

    fn set_buffering(&self, buffering: bool) {
        if self.buffering.replace(buffering) != buffering {
            self.report(AudioEvent::Buffer { buffering });
        }
    }

    fn current(&self) -> Option<gtk::MediaFile> {
        self.stream.borrow().clone()
    }

    fn duration(&self) -> Option<Duration> {
        self.current().and_then(|s| micros(s.duration()))
    }

    /// The stream, made (and its load watched) the first time.
    fn stream(self: &Rc<Self>) -> Option<gtk::MediaFile> {
        if let Some(stream) = self.current() {
            return Some(stream);
        }
        if self.failed.get() {
            return None;
        }
        let stream = gtk::MediaFile::for_file(self.file.as_ref()?);
        let settings = self.settings.get();
        stream.set_volume(f64::from(settings.volume.clamp(0.0, 1.0)));
        stream.set_loop(settings.looped);
        warn_rate(settings.rate);
        let mut handlers = Vec::new();
        let weak = Rc::downgrade(self);
        handlers.push(stream.connect_prepared_notify({
            let weak = weak.clone();
            move |_| {
                if let Some(this) = weak.upgrade() {
                    this.prepared();
                }
            }
        }));
        handlers.push(stream.connect_ended_notify({
            let weak = weak.clone();
            move |stream| {
                if stream.is_ended()
                    && let Some(this) = weak.upgrade()
                {
                    this.ended();
                }
            }
        }));
        handlers.push(stream.connect_error_notify({
            let weak = weak.clone();
            move |stream| {
                let Some(err) = stream.error() else { return };
                if let Some(this) = weak.upgrade() {
                    let kind = if this.network {
                        AudioError::Network
                    } else {
                        AudioError::Decode
                    };
                    stream.set_playing(false);
                    this.fail(kind, &media_error(err.message()));
                }
            }
        }));
        *self.handlers.borrow_mut() = handlers;
        *self.stream.borrow_mut() = Some(stream.clone());
        // A paused stream reports no progress, a stream that never
        // prepares no error: a timer watches both.
        let started = Instant::now();
        let weak = Rc::downgrade(self);
        *self.progress.borrow_mut() = Some(glib::timeout_add_local(PROGRESS_INTERVAL, move || {
            let Some(this) = weak.upgrade() else {
                return glib::ControlFlow::Break;
            };
            if !this.loaded.get() && !this.failed.get() && started.elapsed() > PREPARE_TIMEOUT * 6 {
                this.fail(
                    AudioError::Network,
                    "the audio did not load within a minute",
                );
            }
            if this.playing.get()
                && this.loaded.get()
                && let Some(stream) = this.current()
            {
                this.report(AudioEvent::Progress {
                    position: Duration::from_micros(stream.timestamp().max(0) as u64),
                    duration: micros(stream.duration()),
                });
            }
            glib::ControlFlow::Continue
        }));
        Some(stream)
    }

    /// The stream prepared: the load, and a play that waited for it.
    fn prepared(&self) {
        let Some(stream) = self.current() else { return };
        if self.loaded.get() || self.failed.get() || !stream.is_prepared() {
            return;
        }
        // GStreamer prepares a stream with no streams when it has no
        // plug-in for them; the error follows.
        if !stream.has_audio() {
            return;
        }
        self.loaded.set(true);
        self.set_buffering(false);
        self.report(AudioEvent::Load {
            duration: micros(stream.duration()),
        });
        if let Some(position) = self.seek_to.take() {
            self.seek(&stream, position);
        }
        if self.wants_play.replace(false) {
            self.start(&stream);
        }
    }

    /// Moves a prepared stream to `position` (at most its end) and reports
    /// where it is: there, or where it stays when it cannot seek (a live
    /// stream).
    fn seek(&self, stream: &gtk::MediaFile, position: Duration) {
        let duration = micros(stream.duration());
        let position = duration.map_or(position, |d| position.min(d));
        let position = if stream.is_seekable() {
            stream.seek(position.as_micros().min(i64::MAX as u128) as i64);
            position
        } else {
            Duration::from_micros(stream.timestamp().max(0) as u64)
        };
        self.report(AudioEvent::Progress { position, duration });
    }

    fn start(&self, stream: &gtk::MediaFile) {
        stream.set_playing(true);
        self.playing.set(true);
        self.report(AudioEvent::Playing);
    }

    /// A stream that does not loop reached its end.
    fn ended(&self) {
        if self.settings.get().looped || !self.playing.replace(false) {
            return;
        }
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
                let _ = self.stream();
            }
            AudioCommand::Resume { .. } => {
                if self.failed.get() && self.file.is_some() {
                    // Tried again from the start.
                    self.close();
                    self.failed.set(false);
                    self.loaded.set(false);
                }
                let Some(stream) = self.stream() else { return };
                if self.loaded.get() {
                    if stream.is_ended() && stream.is_seekable() {
                        stream.seek(0);
                    }
                    self.start(&stream);
                } else {
                    self.wants_play.set(true);
                    self.set_buffering(true);
                }
            }
            AudioCommand::Pause { .. } => {
                self.wants_play.set(false);
                if let Some(stream) = self.current() {
                    stream.set_playing(false);
                }
                if self.playing.replace(false) {
                    self.report(AudioEvent::Paused);
                }
            }
            AudioCommand::Seek { position, .. } => {
                let Some(stream) = self.stream() else { return };
                if self.loaded.get() {
                    self.seek(&stream, *position);
                } else {
                    // `prepared` applies it (the last one asked).
                    self.seek_to.set(Some(*position));
                }
            }
            AudioCommand::Set { settings, .. } => {
                self.settings.set(*settings);
                warn_rate(settings.rate);
                if let Some(stream) = self.current() {
                    stream.set_volume(f64::from(settings.volume.clamp(0.0, 1.0)));
                    stream.set_loop(settings.looped);
                }
            }
            _ => {}
        }
    }

    /// Stops the player and frees its stream.
    fn close(&self) {
        if let Some(id) = self.progress.borrow_mut().take() {
            id.remove();
        }
        let handlers = std::mem::take(&mut *self.handlers.borrow_mut());
        let stream = self.stream.borrow_mut().take();
        if let Some(stream) = stream {
            for handler in handlers {
                stream.disconnect(handler);
            }
            stream.set_playing(false);
            stream.clear();
        }
        self.playing.set(false);
        self.wants_play.set(false);
        self.seek_to.set(None);
    }
}

/// Where `src` is (`asset:/` URIs against `base`).
fn locate(src: &str, base: Option<&AssetBase>) -> Option<gio::File> {
    if let Some(path) = src.strip_prefix("asset:/") {
        let path = path.trim_start_matches('/');
        return match base? {
            AssetBase::Http(url) => Some(gio::File::for_uri(&format!(
                "{}/{path}",
                url.trim_end_matches('/')
            ))),
            dirs @ (AssetBase::Directory(_) | AssetBase::Directories(_)) => {
                dirs.file(path).map(gio::File::for_path)
            }
        };
    }
    if src.contains("://") {
        Some(gio::File::for_uri(src))
    } else if src.is_empty() {
        None
    } else {
        Some(gio::File::for_path(src))
    }
}

/// What GStreamer says, for apps: its first line without the element path.
fn media_error(message: &str) -> String {
    let line = message.lines().next().unwrap_or(message).trim();
    match line.strip_prefix("Error from element ") {
        Some(rest) => rest.split_once(": ").map_or(rest, |(_, m)| m),
        None => line,
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microseconds_are_durations_when_known() {
        assert_eq!(micros(0), None);
        assert_eq!(micros(-1), None);
        assert_eq!(micros(1_500_000), Some(Duration::from_millis(1500)));
    }

    #[test]
    fn media_errors_lose_the_element_path() {
        assert_eq!(
            media_error("Error from element /GstPlayBin3:p: Could not open.\nmore"),
            "Could not open."
        );
        assert_eq!(media_error("plain"), "plain");
    }
}
