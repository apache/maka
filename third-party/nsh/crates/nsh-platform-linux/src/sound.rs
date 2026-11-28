//! Sounds on Linux (`nsh`'s `Sound`; `audio.rs` drives them): decoded once
//! into memory by GStreamer, played from there by one mixing pipeline per
//! engine.
//!
//! - **Decoding** ([`decode`]) runs off the main thread into 32-bit float,
//!   stereo, 48 kHz samples, stopped at the length the core allows. A PCM
//!   WAV file, the format sounds ship in, is read here ([`wav`]): it plays
//!   with GStreamer's base plug-ins alone (`wavparse` is a "good" one).
//!   Anything else goes through a pipeline of its own, `decodebin`
//!   (whatever GStreamer's plug-ins read). The samples are the sound:
//!   nothing is read or decoded again at a play.
//! - **Playing** ([`Mixer`]): one live pipeline, a silent source into an
//!   `audiomixer` into the default output (`autoaudiosink`, a "good"
//!   plug-in; without it the first of PipeWire's, PulseAudio's and ALSA's
//!   sinks installed: [`OUTPUTS`]), made at the
//!   first play and kept. Each play is a voice: an `appsrc` holding the
//!   samples (shared, not copied, at the recorded rate; resampled once at
//!   another rate, the pitch with it, as on the other platforms), linked to
//!   a mixer pad whose `volume` is the play's, its first sample placed at
//!   the pipeline's running time when it is added. So a play starts within
//!   the output's latency and plays overlap. A voice is removed once its
//!   samples played (looked at when the next play or stop comes); past
//!   [`MAX_VOICES`] the oldest stops.
//! - An output that cannot start, or that fails later (an error on the
//!   bus), makes sounds silence: the mixer is made again at the next play.
//! - A sound whose format no installed plug-in decodes (FLAC and MP3 need
//!   gst-plugins-good) fails as [`Failure::Unsupported`], naming the format,
//!   so the app sees `not-supported` rather than bytes it cannot read.
//!
//! The samples' format is fixed ([`RATE`], two channels): what desktop
//! outputs mix at, so the output's own conversion is usually none.

use std::{
    cell::Cell,
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::gst::{self, Buffer, Caps, Object};

/// The samples' rate.
pub(crate) const RATE: u32 = 48_000;
/// The samples' channels.
const CHANNELS: usize = 2;
/// Bytes of one frame: a 32-bit float per channel.
const FRAME_BYTES: usize = CHANNELS * 4;
/// The silent source's buffers, so the mixer's own latency is one of them.
const SILENCE_SAMPLES: i32 = 480;
/// How long a sound may take to decode.
const DECODE_TIMEOUT: Duration = Duration::from_secs(10);
/// Voices at once (`nsh_core::audio::MAX_VOICES`).
const MAX_VOICES: usize = 32;
/// The outputs a mixer plays into, the first installed: the system's
/// default, then PipeWire, PulseAudio and ALSA directly (`alsasink` is a
/// base plug-in).
const OUTPUTS: &[&str] = &["autoaudiosink", "pipewiresink", "pulsesink", "alsasink"];

/// A decoded sound: interleaved 32-bit float frames, little-endian, at
/// [`RATE`]. Cloning shares the samples.
#[derive(Clone)]
pub(crate) struct Pcm(Arc<[u8]>);

impl Pcm {
    /// Its size in bytes, as the core counts decoded audio.
    pub(crate) fn bytes(&self) -> u64 {
        self.0.len() as u64
    }

    fn frames(&self) -> usize {
        self.0.len() / FRAME_BYTES
    }
}

/// What [`decode`] made of a sound.
pub(crate) struct Decoded {
    pub(crate) pcm: Pcm,
    pub(crate) duration: Duration,
    /// Longer than the length asked for, and cut there.
    pub(crate) truncated: bool,
}

/// Loads and starts GStreamer once (GTK's media streams may have started
/// it already); without it, the library missing is named.
fn init() -> Result<(), String> {
    gst::api().map(|_| ())
}

/// The samples' caps.
fn caps_string() -> String {
    format!("audio/x-raw,format=F32LE,layout=interleaved,rate={RATE},channels={CHANNELS}")
}

fn caps() -> Caps {
    Caps::parse(&caps_string())
}

fn element(factory: &str) -> Result<Object, String> {
    Object::element(factory)
}

/// Why a sound did not decode.
#[derive(Debug)]
pub(crate) enum Failure {
    /// No installed plug-in decodes its format (`not-supported`).
    Unsupported(String),
    /// Anything else: bytes that are not audio, a broken pipeline
    /// (`decode`).
    Other(String),
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Other(message)
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Failure::Other(message.to_owned())
    }
}

/// What a sound of `format` (a caps name, when the decoder said which)
/// that no plug-in decodes fails with.
fn unsupported(format: Option<&str>) -> Failure {
    let format = format.map_or("its format".to_owned(), |f| format!("`{f}`"));
    Failure::Unsupported(format!(
        "no installed GStreamer plug-in decodes {format}: FLAC and MP3 need \
         gst-plugins-good, AAC and most others gst-libav"
    ))
}

/// The duration of `frames` at [`RATE`].
fn duration_of(frames: usize) -> Duration {
    Duration::from_secs_f64(frames as f64 / f64::from(RATE))
}

/// Decodes `bytes` into memory, at most `max` of them. Blocks: off the main
/// thread.
pub(crate) fn decode(bytes: Vec<u8>, max: Duration) -> Result<Decoded, Failure> {
    if let Some(samples) = wav::read(&bytes) {
        let samples = samples?;
        let limit = (max.as_secs_f64() * f64::from(RATE)).ceil() as usize;
        let truncated = samples.len() / CHANNELS > limit;
        let mut out = Vec::with_capacity(samples.len().min(limit * CHANNELS) * 4);
        for v in samples.iter().take(limit * CHANNELS) {
            out.extend_from_slice(&v.to_le_bytes());
        }
        if out.is_empty() {
            return Err("the sound has no samples".into());
        }
        let pcm = Pcm(out.into());
        return Ok(Decoded {
            duration: duration_of(pcm.frames()),
            pcm,
            truncated,
        });
    }
    // Without GStreamer only WAV files load: anything else is a format
    // nothing here decodes.
    init().map_err(Failure::Unsupported)?;
    let pipeline = Object::pipeline();
    let src = element("appsrc")?;
    src.set("format", "bytes");
    let decoder = element("decodebin")?;
    let convert = element("audioconvert")?;
    let resample = element("audioresample")?;
    let sink = element("appsink")?;
    sink.set_sink_caps(&caps());
    sink.set("sync", "false");
    for e in [&src, &decoder, &convert, &resample, &sink] {
        pipeline.add(e)?;
    }
    Object::link_many(&[&src, &decoder])?;
    Object::link_many(&[&convert, &resample, &sink])?;
    // The decoder's pads come once it knows the stream: the first audio one
    // is the sound (a file with video too gives its audio).
    let convert_sink = convert
        .static_pad("sink")
        .ok_or("audioconvert has no sink")?;
    decoder.on_pad_added(move |pad| {
        let audio = pad
            .current_caps()
            .and_then(|caps| caps.name())
            .is_some_and(|name| name.starts_with("audio/"));
        if audio && !convert_sink.is_linked() {
            let _ = pad.link_pad(&convert_sink);
        }
    });
    // A stream the decoder recognized but has no plug-in for: its caps name
    // the format the app is told about.
    let missing = Arc::new(Mutex::new(None::<String>));
    decoder.on_unknown_type({
        let missing = missing.clone();
        move |name| {
            if let Ok(mut missing) = missing.lock()
                && missing.is_none()
            {
                *missing = Some(name.unwrap_or_default());
            }
        }
    });
    let result = pull(&pipeline, &src, &sink, bytes, max);
    let _ = pipeline.set_state(gst::STATE_NULL);
    let missing = missing.lock().ok().and_then(|m| m.clone());
    let format = missing.as_deref().filter(|f| !f.is_empty());
    // The bus's missing-plug-in error does not say which format: the
    // decoder's `unknown-type` does.
    let (bytes, truncated) = match result {
        Ok(result) => result,
        Err(Failure::Unsupported(_)) => return Err(unsupported(format)),
        Err(Failure::Other(_)) if missing.is_some() => return Err(unsupported(format)),
        Err(failure) => return Err(failure),
    };
    if bytes.is_empty() {
        if missing.is_some() {
            return Err(unsupported(format));
        }
        return Err("the sound has no audio GStreamer can decode".into());
    }
    let pcm = Pcm(bytes.into());
    Ok(Decoded {
        duration: duration_of(pcm.frames()),
        pcm,
        truncated,
    })
}

/// Runs the decoding `pipeline` and collects its samples: the bytes and
/// whether they were cut at `max`.
fn pull(
    pipeline: &Object,
    src: &Object,
    sink: &Object,
    bytes: Vec<u8>,
    max: Duration,
) -> Result<(Vec<u8>, bool), Failure> {
    let limit = (max.as_secs_f64() * f64::from(RATE)).ceil() as usize * FRAME_BYTES;
    src.push_buffer(Buffer::wrap(bytes))
        .map_err(|e| format!("the sound cannot be read: {e}"))?;
    src.end_of_stream();
    pipeline
        .set_state(gst::STATE_PLAYING)
        .map_err(|_| "the sound cannot be decoded".to_owned())?;
    let bus = pipeline.bus().ok_or("the pipeline has no bus")?;
    let deadline = Instant::now() + DECODE_TIMEOUT;
    let mut out = Vec::new();
    loop {
        if let Some(sample) = sink.try_pull_sample(50_000_000) {
            sample.append_to(&mut out);
            if out.len() > limit {
                out.truncate(limit);
                return Ok((out, true));
            }
            continue;
        }
        if sink.is_eos() {
            return Ok((out, false));
        }
        if let Some(message) = bus.pop_error() {
            let error = message.error();
            if error.missing_plugin {
                return Err(unsupported(None));
            }
            return Err(error.message.into());
        }
        if Instant::now() > deadline {
            return Err("the sound did not decode in time".into());
        }
    }
}

/// `pcm` played at `rate`: resampled (linearly) so that it lasts
/// `1 / rate` as long, the pitch going with it.
fn at_rate(pcm: &Pcm, rate: f32) -> Pcm {
    if (rate - 1.0).abs() < f32::EPSILON || pcm.frames() < 2 {
        return pcm.clone();
    }
    let sample = |frame: usize, channel: usize| {
        let at = frame * FRAME_BYTES + channel * 4;
        f32::from_le_bytes(pcm.0[at..at + 4].try_into().expect("four bytes"))
    };
    let last = pcm.frames() - 1;
    let frames = ((pcm.frames() as f64) / f64::from(rate)).floor() as usize;
    let mut out = Vec::with_capacity(frames * FRAME_BYTES);
    for i in 0..frames {
        let at = i as f64 * f64::from(rate);
        let from = (at.floor() as usize).min(last);
        let to = (from + 1).min(last);
        let t = (at - from as f64) as f32;
        for channel in 0..CHANNELS {
            let (a, b) = (sample(from, channel), sample(to, channel));
            out.extend_from_slice(&(a + (b - a) * t).to_le_bytes());
        }
    }
    Pcm(out.into())
}

/// A play: its source and the mixer pad it plays through.
struct Voice {
    sound: u32,
    src: Object,
    pad: Object,
    started: Instant,
    /// When its samples will have played.
    until: Instant,
}

/// The pipeline every sound of an engine plays through.
pub(crate) struct Mixer {
    pipeline: Object,
    mixer: Object,
    voices: Vec<Voice>,
    /// Set by the bus when the output failed.
    broken: Rc<Cell<bool>>,
    _bus: Option<gst::Watch>,
    /// The output element, which tests read from.
    #[cfg(test)]
    output: Object,
}

impl Mixer {
    /// Makes the pipeline, playing into the default output, its failures
    /// watched on the main loop. On the main thread.
    pub(crate) fn new() -> Result<Mixer, String> {
        init()?;
        let output = OUTPUTS
            .iter()
            .find(|factory| gst::has_element(factory))
            .ok_or("no GStreamer audio output is installed")?;
        let mut mixer = Self::with_sink(output)?;
        let flag = mixer.broken.clone();
        mixer._bus = mixer.pipeline.bus().and_then(|bus| {
            bus.watch_errors(move |error| {
                log::warn!("the sound output failed: {}", error.message);
                flag.set(true);
            })
        });
        Ok(mixer)
    }

    /// Makes the pipeline, playing into an element of `sink` (tests use
    /// `fakesink`), unwatched.
    fn with_sink(sink: &str) -> Result<Mixer, String> {
        init()?;
        let pipeline = Object::pipeline();
        // The silent source keeps the mixer running, live, between plays:
        // a voice's samples go at the running time they were added at. Its
        // silence is a sine of no frequency, zeros, rather than the
        // `silence` wave: that one's buffers are gaps, which an audio sink
        // drops rather than writes, so it loses its place in the output
        // and cuts the first tens of milliseconds of the next play (all of
        // a click).
        let silence = element("audiotestsrc")?;
        silence.set("wave", "sine");
        silence.set("freq", "0");
        silence.set("is-live", "true");
        silence.set("samplesperbuffer", &SILENCE_SAMPLES.to_string());
        let filter = element("capsfilter")?;
        filter.set("caps", &caps_string());
        let mixer = element("audiomixer")?;
        let convert = element("audioconvert")?;
        let resample = element("audioresample")?;
        let output = element(sink)?;
        let all = [&silence, &filter, &mixer, &convert, &resample, &output];
        for e in all {
            pipeline.add(e)?;
        }
        Object::link_many(&all)?;
        pipeline
            .set_state(gst::STATE_PLAYING)
            .map_err(|_| "the sound output did not start".to_owned())?;
        Ok(Mixer {
            pipeline,
            mixer,
            voices: Vec::new(),
            broken: Rc::default(),
            _bus: None,
            #[cfg(test)]
            output,
        })
    }

    /// Whether the output failed: the next play makes a new mixer.
    pub(crate) fn is_broken(&self) -> bool {
        self.broken.get()
    }

    /// Plays `pcm` (the samples of `sound`) at `volume` and `rate`, over
    /// what plays.
    pub(crate) fn play(
        &mut self,
        sound: u32,
        pcm: &Pcm,
        volume: f32,
        rate: f32,
    ) -> Result<(), String> {
        self.sweep();
        if self.voices.len() >= MAX_VOICES
            && let Some(oldest) = (0..self.voices.len()).min_by_key(|&i| self.voices[i].started)
        {
            let voice = self.voices.remove(oldest);
            self.remove(voice);
        }
        let pcm = at_rate(pcm, rate);
        let length = duration_of(pcm.frames());
        let src = element("appsrc")?;
        src.set_src_caps(&caps());
        src.set("format", "time");
        src.set("is-live", "true");
        // Its samples are all queued at once: no latency, and no bound on
        // how long they may wait. By default a live `appsrc` answers a
        // latency of at most 0, below the silent source's 10 ms, and the
        // mixer, unable to set its latency, mixes without waiting for the
        // voice and drops its samples as late.
        src.set("min-latency", "0");
        self.pipeline.add(&src)?;
        let pad = self
            .mixer
            .request_pad("sink_%u")
            .ok_or("the mixer gave no pad")?;
        pad.set("volume", &f64::from(volume.clamp(0.0, 1.0)).to_string());
        let src_pad = src.static_pad("src").ok_or("appsrc has no pad")?;
        // The samples start at 0 in their segment: offset to the running
        // time now, they play from now on (and are not late).
        let now = self.pipeline.running_time().unwrap_or(0);
        src_pad.set_offset(now as i64);
        let voice = Voice {
            sound,
            src: src.clone(),
            pad: pad.clone(),
            started: Instant::now(),
            until: Instant::now() + length,
        };
        if let Err(e) = src_pad.link_pad(&pad) {
            self.remove(voice);
            return Err(e);
        }
        let mut buffer = Buffer::wrap(Shared(pcm.0.clone()));
        buffer.set_timing(0, length.as_nanos() as u64);
        let pushed = src.sync_state_with_parent().and_then(|()| {
            src.push_buffer(buffer)?;
            src.end_of_stream();
            Ok(())
        });
        if let Err(e) = pushed {
            self.remove(voice);
            return Err(e);
        }
        self.voices.push(voice);
        Ok(())
    }

    /// Stops the plays of `sound`.
    pub(crate) fn stop(&mut self, sound: u32) {
        let (stopped, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.voices)
            .into_iter()
            .partition(|v| v.sound == sound);
        self.voices = rest;
        for voice in stopped {
            self.remove(voice);
        }
    }

    /// The voices playing.
    #[cfg(test)]
    fn voices(&self) -> usize {
        self.voices.len()
    }

    /// Removes the voices that played to their end.
    fn sweep(&mut self) {
        let now = Instant::now();
        let (done, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.voices)
            .into_iter()
            .partition(|v| v.until <= now);
        self.voices = rest;
        for voice in done {
            self.remove(voice);
        }
    }

    fn remove(&self, voice: Voice) {
        let _ = voice.src.set_state(gst::STATE_NULL);
        if let Some(src_pad) = voice.src.static_pad("src") {
            src_pad.unlink_pad(&voice.pad);
        }
        self.mixer.release_request_pad(&voice.pad);
        self.pipeline.remove(&voice.src);
    }
}

impl Drop for Mixer {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::STATE_NULL);
    }
}

/// Samples shared with a buffer.
struct Shared(Arc<[u8]>);

impl AsRef<[u8]> for Shared {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// PCM WAV files, read without GStreamer.
mod wav {
    use super::{CHANNELS, RATE};

    /// The samples of `bytes` as [`RATE`] stereo floats, interleaved:
    /// `None` when they are not a WAV file, an error when it is one this
    /// cannot read (compressed, damaged).
    pub(super) fn read(bytes: &[u8]) -> Option<Result<Vec<f32>, String>> {
        if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return None;
        }
        Some(samples(bytes))
    }

    fn u16_at(b: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([b[at], b[at + 1]])
    }

    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    fn samples(bytes: &[u8]) -> Result<Vec<f32>, String> {
        // (format, channels, rate, bits)
        let mut format = None;
        let mut data = None;
        let mut at = 12;
        while at + 8 <= bytes.len() {
            let size = u32_at(bytes, at + 4) as usize;
            let body = at + 8;
            let end = body.saturating_add(size).min(bytes.len());
            match &bytes[at..at + 4] {
                b"fmt " if end - body >= 16 => {
                    let mut tag = u16_at(bytes, body);
                    // WAVE_FORMAT_EXTENSIBLE: the format is its sub-format's.
                    if tag == 0xfffe && end - body >= 26 {
                        tag = u16_at(bytes, body + 24);
                    }
                    format = Some((
                        tag,
                        usize::from(u16_at(bytes, body + 2)),
                        u32_at(bytes, body + 4),
                        u16_at(bytes, body + 14),
                    ));
                }
                b"data" => data = Some(&bytes[body..end]),
                _ => {}
            }
            // Chunks are padded to an even size.
            at = body.saturating_add(size).saturating_add(size & 1);
        }
        let (tag, channels, rate, bits) = format.ok_or("the WAV file has no format")?;
        let data = data.ok_or("the WAV file has no data")?;
        if channels == 0 || rate == 0 {
            return Err("the WAV file has no channels".into());
        }
        let read: fn(&[u8]) -> f32 = match (tag, bits) {
            (1, 8) => |s| (f32::from(s[0]) - 128.0) / 128.0,
            (1, 16) => |s| f32::from(i16::from_le_bytes([s[0], s[1]])) / 32_768.0,
            (1, 24) => |s| (i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8) as f32 / 8_388_608.0,
            (1, 32) => |s| i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32 / 2_147_483_648.0,
            (3, 32) => |s| f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
            _ => {
                return Err(format!(
                    "WAV files of format {tag} at {bits} bits are not read here"
                ));
            }
        };
        let width = usize::from(bits / 8);
        let frame = width * channels;
        let frames = data.len() / frame;
        // The first two channels; a mono sound on both sides.
        let source: Vec<[f32; CHANNELS]> = (0..frames)
            .map(|i| {
                let f = &data[i * frame..];
                let left = read(f);
                let right = if channels > 1 {
                    read(&f[width..])
                } else {
                    left
                };
                [left, right]
            })
            .collect();
        // Linear resampling to [`RATE`]: sounds are short, and their
        // highs are far below where it would fold them back.
        let step = f64::from(rate) / f64::from(RATE);
        let count = if rate == RATE {
            frames
        } else {
            (frames as f64 / step).floor() as usize
        };
        let mut out = Vec::with_capacity(count * CHANNELS);
        for i in 0..count {
            let at = i as f64 * step;
            let from = (at.floor() as usize).min(frames.saturating_sub(1));
            let to = (from + 1).min(frames.saturating_sub(1));
            let t = (at - from as f64) as f32;
            for (a, b) in source[from].iter().zip(source[to]) {
                out.push(a + (b - a) * t);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A WAV file of a 440 Hz tone, 16-bit mono at 8 kHz, `ms` long.
    fn tone(ms: u32) -> Vec<u8> {
        let samples = 8 * ms;
        let data = samples * 2;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data.to_le_bytes());
        for i in 0..samples {
            let t = i as f32 / 8000.0;
            let v = ((t * 440.0 * std::f32::consts::TAU).sin() * 8000.0) as i16;
            wav.extend_from_slice(&v.to_le_bytes());
        }
        wav
    }

    fn near(a: Duration, b: Duration) -> bool {
        a.abs_diff(b) < Duration::from_millis(20)
    }

    #[test]
    fn decodes_a_sound_into_memory() {
        let decoded = decode(tone(500), Duration::from_secs(5)).unwrap();
        assert!(
            near(decoded.duration, Duration::from_millis(500)),
            "{:?}",
            decoded.duration
        );
        assert!(!decoded.truncated);
        assert_eq!(
            decoded.pcm.bytes() as usize,
            decoded.pcm.frames() * FRAME_BYTES
        );
    }

    /// A float WAV in stereo at 44.1 kHz, `ms` long, of `value` on the left
    /// and silence on the right.
    fn stereo_float(ms: u32, value: f32) -> Vec<u8> {
        let frames = 44_100 * ms / 1000;
        let data = frames * 8;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&3u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&44_100u32.to_le_bytes());
        wav.extend_from_slice(&(44_100u32 * 8).to_le_bytes());
        wav.extend_from_slice(&8u16.to_le_bytes());
        wav.extend_from_slice(&32u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data.to_le_bytes());
        for _ in 0..frames {
            wav.extend_from_slice(&value.to_le_bytes());
            wav.extend_from_slice(&0f32.to_le_bytes());
        }
        wav
    }

    #[test]
    fn reads_a_wav_file_without_gstreamer() {
        let samples = wav::read(&stereo_float(200, 0.5)).unwrap().unwrap();
        // Resampled to 48 kHz, its channels kept apart.
        assert_eq!(samples.len() / CHANNELS, 9600);
        assert!(
            samples
                .chunks(2)
                .all(|f| (f[0] - 0.5).abs() < 1e-6 && f[1] == 0.0)
        );
        assert!(wav::read(b"not a sound at all").is_none());
    }

    #[test]
    fn cuts_a_sound_at_its_limit() {
        let decoded = decode(tone(1000), Duration::from_millis(250)).unwrap();
        assert!(decoded.truncated);
        assert!(
            near(decoded.duration, Duration::from_millis(250)),
            "{:?}",
            decoded.duration
        );
    }

    #[test]
    fn refuses_what_is_not_audio() {
        let failure = decode(b"not a sound at all".to_vec(), Duration::from_secs(5)).err();
        assert!(matches!(failure, Some(Failure::Other(_))), "{failure:?}");
    }

    #[test]
    fn a_format_without_its_plug_in_is_unsupported() {
        init().unwrap();
        // GStreamer's base plug-ins recognize a SID tune (`audio/x-sid`) by
        // its header; its decoder is in gst-plugins-ugly, which CI does not
        // install.
        if gst::has_element("siddec") {
            return;
        }
        let mut tune = b"PSID".to_vec();
        tune.resize(512, 0);
        match decode(tune, Duration::from_secs(5)).err() {
            Some(Failure::Unsupported(message)) => {
                assert!(message.contains("`audio/x-sid`"), "{message}");
                assert!(message.contains("gst-plugins-good"), "{message}");
            }
            other => panic!("not unsupported: {other:?}"),
        }
    }

    /// An Ogg Vorbis tone of about `ms`, encoded by GStreamer itself (base
    /// plug-ins), `None` without an encoder.
    fn ogg(ms: u32) -> Option<Vec<u8>> {
        init().ok()?;
        let pipeline = Object::pipeline();
        let src = element("audiotestsrc").ok()?;
        src.set("num-buffers", &(ms / 10).to_string());
        src.set("samplesperbuffer", "480");
        let convert = element("audioconvert").ok()?;
        let encoder = element("vorbisenc").ok()?;
        let mux = element("oggmux").ok()?;
        let sink = element("appsink").ok()?;
        sink.set("sync", "false");
        let all = [&src, &convert, &encoder, &mux, &sink];
        for e in all {
            pipeline.add(e).ok()?;
        }
        Object::link_many(&all).ok()?;
        pipeline.set_state(gst::STATE_PLAYING).ok()?;
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !sink.is_eos() && Instant::now() < deadline {
            if let Some(sample) = sink.try_pull_sample(50_000_000) {
                sample.append_to(&mut out);
            }
        }
        let _ = pipeline.set_state(gst::STATE_NULL);
        Some(out)
    }

    #[test]
    fn decodes_a_compressed_sound_through_gstreamer() {
        let Some(bytes) = ogg(500) else {
            return;
        };
        let decoded = decode(bytes, Duration::from_secs(5)).unwrap();
        // 50 buffers of 480 frames at audiotestsrc's 44.1 kHz.
        let expected = Duration::from_secs_f64(24_000.0 / 44_100.0);
        assert!(
            decoded.duration.abs_diff(expected) < Duration::from_millis(60),
            "{:?}",
            decoded.duration
        );
    }

    #[test]
    fn a_rate_changes_the_length() {
        let pcm = decode(tone(400), Duration::from_secs(5)).unwrap().pcm;
        let fast = at_rate(&pcm, 2.0);
        let slow = at_rate(&pcm, 0.5);
        assert_eq!(fast.frames(), pcm.frames() / 2);
        assert_eq!(slow.frames(), pcm.frames() * 2);
        assert!(
            Arc::ptr_eq(&at_rate(&pcm, 1.0).0, &pcm.0),
            "rate 1 shares the samples"
        );
    }

    #[test]
    fn plays_overlap_and_end() {
        let pcm = decode(tone(100), Duration::from_secs(5)).unwrap().pcm;
        let mut mixer = Mixer::with_sink("fakesink").unwrap();
        mixer.play(1, &pcm, 1.0, 1.0).unwrap();
        mixer.play(1, &pcm, 0.5, 2.0).unwrap();
        mixer.play(2, &pcm, 1.0, 1.0).unwrap();
        assert_eq!(mixer.voices(), 3);
        mixer.stop(1);
        assert_eq!(mixer.voices(), 1);
        std::thread::sleep(Duration::from_millis(200));
        mixer.sweep();
        assert_eq!(mixer.voices(), 0);
        assert!(!mixer.is_broken());
    }

    /// Between plays the output gets silence, not gaps: an audio sink
    /// drops a gap and cuts the start of the play after it.
    #[test]
    fn the_silence_between_plays_is_not_a_gap() {
        let mixer = Mixer::with_sink("appsink").unwrap();
        let sample = (0..20)
            .find_map(|_| mixer.output.try_pull_sample(100_000_000))
            .expect("the mixer's output");
        assert!(!sample.is_gap());
    }

    #[test]
    fn past_the_voices_the_oldest_stops() {
        let pcm = decode(tone(1000), Duration::from_secs(5)).unwrap().pcm;
        let mut mixer = Mixer::with_sink("fakesink").unwrap();
        for _ in 0..MAX_VOICES + 3 {
            mixer.play(1, &pcm, 1.0, 1.0).unwrap();
        }
        assert_eq!(mixer.voices(), MAX_VOICES);
    }
}
