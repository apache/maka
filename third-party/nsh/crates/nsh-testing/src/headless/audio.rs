use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_core::audio::{AudioBackend, AudioCommand, AudioError, AudioEvent, AudioSink};

/// What the app asked of the fake speaker, as a test reads it.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct AudioCall {
    /// `load`, `play`, `stop`, `unload` for sounds; `open`, `preload`,
    /// `resume`, `pause`, `seek`, `set`, `close` for players.
    pub command: &'static str,
    /// The sound's or player's source.
    pub src: String,
    /// `play`'s and `set`'s volume.
    pub volume: Option<f32>,
    /// `play`'s and `set`'s rate.
    pub rate: Option<f32>,
    /// `seek`'s position.
    pub position: Option<Duration>,
}

/// A player of the fake speaker.
struct Player {
    src: String,
    sink: AudioSink,
    loaded: bool,
    playing: bool,
    looped: bool,
}

/// What the fake speaker holds and heard.
#[derive(Default)]
struct Speaker {
    calls: Vec<AudioCall>,
    /// The sources of the sounds loaded, by id.
    sounds: HashMap<u32, String>,
    players: HashMap<u32, Player>,
}

/// An [`AudioBackend`] that plays nothing and records everything: sounds
/// decode as WAV (their length from the header), players last
/// [`PLAYER_DURATION`] and end when the test says.
#[derive(Clone, Default)]
pub(crate) struct FakeAudio(Arc<Mutex<Speaker>>);

/// How long a fake player's source plays.
const PLAYER_DURATION: Duration = Duration::from_secs(60);

impl FakeAudio {
    fn with<T>(&self, f: impl FnOnce(&mut Speaker) -> T) -> T {
        f(&mut self.0.lock().expect("fake speaker"))
    }

    /// What the app asked so far, in order.
    pub(crate) fn calls(&self) -> Vec<AudioCall> {
        self.with(|s| s.calls.clone())
    }

    /// The players playing reach their end: `end` (those that loop start
    /// again). Fails when none plays.
    pub(crate) fn end(&self) -> Result<(), String> {
        self.with(|s| {
            let playing: Vec<&mut Player> = s.players.values_mut().filter(|p| p.playing).collect();
            if playing.is_empty() {
                return Err("no player plays".to_owned());
            }
            for player in playing {
                if player.looped {
                    player.sink.send(AudioEvent::Progress {
                        position: Duration::ZERO,
                        duration: Some(PLAYER_DURATION),
                    });
                } else {
                    player.playing = false;
                    player.sink.send(AudioEvent::Progress {
                        position: PLAYER_DURATION,
                        duration: Some(PLAYER_DURATION),
                    });
                    player.sink.send(AudioEvent::Ended);
                }
            }
            Ok(())
        })
    }
}

/// A WAV file's length and the size of its audio: what a decoder reports.
fn wav(bytes: &[u8]) -> Option<(Duration, u64)> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut at = 12;
    let mut byte_rate = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?) as usize;
        let body = at + 8;
        match id {
            b"fmt " if body + 12 <= bytes.len() => {
                byte_rate = Some(u32::from_le_bytes(
                    bytes[body + 8..body + 12].try_into().ok()?,
                ));
            }
            b"data" => {
                let rate = u64::from(byte_rate.filter(|r| *r > 0)?);
                let size = size as u64;
                return Some((Duration::from_secs_f64(size as f64 / rate as f64), size));
            }
            _ => {}
        }
        at = body + size + (size & 1);
    }
    None
}

impl AudioBackend for FakeAudio {
    fn command(&self, command: AudioCommand, events: &AudioSink) {
        self.with(|s| {
            let id = command.id();
            let src = s
                .sounds
                .get(&id)
                .or(s.players.get(&id).map(|p| &p.src))
                .cloned()
                .unwrap_or_default();
            let mut call = AudioCall {
                command: "",
                src,
                volume: None,
                rate: None,
                position: None,
            };
            match command {
                AudioCommand::Load {
                    bytes,
                    hint,
                    max_duration,
                    ..
                } => {
                    call.command = "load";
                    call.src = hint.clone();
                    s.sounds.insert(id, hint);
                    match wav(&bytes) {
                        Some((duration, size)) => {
                            let truncated = duration > max_duration;
                            events.send(AudioEvent::Loaded {
                                duration: duration.min(max_duration),
                                bytes: size,
                                truncated,
                            });
                        }
                        None => {
                            events.send(AudioEvent::Failed {
                                error: AudioError::Decode,
                                message: "not a WAV file (the fake decodes WAV only)".into(),
                            });
                        }
                    }
                }
                AudioCommand::Play { volume, rate, .. } => {
                    call.command = "play";
                    call.volume = Some(volume);
                    call.rate = Some(rate);
                }
                AudioCommand::Stop { .. } => call.command = "stop",
                AudioCommand::Unload { .. } => {
                    call.command = "unload";
                    s.sounds.remove(&id);
                }
                AudioCommand::Open { src, settings, .. } => {
                    call.command = "open";
                    call.src = src.clone();
                    call.volume = Some(settings.volume);
                    call.rate = Some(settings.rate);
                    s.players.insert(
                        id,
                        Player {
                            src,
                            sink: events.clone(),
                            loaded: false,
                            playing: false,
                            looped: settings.looped,
                        },
                    );
                }
                AudioCommand::Preload { .. } | AudioCommand::Resume { .. } => {
                    let resume = matches!(command, AudioCommand::Resume { .. });
                    call.command = if resume { "resume" } else { "preload" };
                    if let Some(player) = s.players.get_mut(&id) {
                        if !player.loaded {
                            player.loaded = true;
                            events.send(AudioEvent::Load {
                                duration: Some(PLAYER_DURATION),
                            });
                        }
                        if resume && !player.playing {
                            player.playing = true;
                            events.send(AudioEvent::Playing);
                        }
                    }
                }
                AudioCommand::Pause { .. } => {
                    call.command = "pause";
                    if let Some(player) = s.players.get_mut(&id)
                        && player.playing
                    {
                        player.playing = false;
                        events.send(AudioEvent::Paused);
                    }
                }
                AudioCommand::Seek { position, .. } => {
                    call.command = "seek";
                    let position = position.min(PLAYER_DURATION);
                    call.position = Some(position);
                    events.send(AudioEvent::Progress {
                        position,
                        duration: Some(PLAYER_DURATION),
                    });
                }
                AudioCommand::Set { settings, .. } => {
                    call.command = "set";
                    call.volume = Some(settings.volume);
                    call.rate = Some(settings.rate);
                    if let Some(player) = s.players.get_mut(&id) {
                        player.looped = settings.looped;
                    }
                }
                AudioCommand::Close { .. } => {
                    call.command = "close";
                    s.players.remove(&id);
                }
                other => {
                    log::warn!("the fake speaker does not know {other:?}");
                    return;
                }
            }
            s.calls.push(call);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::wav;

    /// A WAV file of `samples` 16-bit mono samples at 8 kHz.
    fn tone(samples: u32) -> Vec<u8> {
        let data = samples * 2;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes()); // bytes a second
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data.to_le_bytes());
        wav.resize(wav.len() + data as usize, 0);
        wav
    }

    #[test]
    fn reads_a_wav_header() {
        let (duration, bytes) = wav(&tone(4000)).unwrap();
        assert_eq!(duration.as_millis(), 500);
        assert_eq!(bytes, 8000);
        assert_eq!(wav(b"ID3 not a wav"), None);
    }
}
