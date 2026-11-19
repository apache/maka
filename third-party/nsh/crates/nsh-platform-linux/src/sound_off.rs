//! Sounds in a runtime built without the feature `sound` (no GStreamer
//! linked): every load fails as not supported, naming the feature, so the
//! app sees `not-supported`; nothing is ever decoded, so nothing plays.
//! The same items as `sound.rs`, which `audio.rs` uses either way.

use std::{convert::Infallible, time::Duration};

/// A decoded sound; none exists without the feature.
#[derive(Clone)]
pub(crate) struct Pcm(Infallible);

impl Pcm {
    /// Its size in bytes.
    pub(crate) fn bytes(&self) -> u64 {
        match self.0 {}
    }
}

/// What [`decode`] made of a sound; never made without the feature.
pub(crate) struct Decoded {
    pub(crate) pcm: Pcm,
    pub(crate) duration: Duration,
    pub(crate) truncated: bool,
}

/// Why a sound did not decode.
#[derive(Debug)]
pub(crate) enum Failure {
    /// What every load fails with here (`not-supported`).
    Unsupported(String),
    /// A decode that stopped (`audio.rs`).
    Other(String),
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Failure::Other(message.to_owned())
    }
}

/// Fails: this runtime decodes no sound.
pub(crate) fn decode(_bytes: Vec<u8>, _max: Duration) -> Result<Decoded, Failure> {
    Err(Failure::Unsupported(
        "sounds need the Linux runtime's feature `sound` (GStreamer), which it was built without"
            .into(),
    ))
}

/// The pipeline sounds play through; none is made without the feature.
pub(crate) struct Mixer(Infallible);

impl Mixer {
    /// Fails: there is no output to play into.
    pub(crate) fn new() -> Result<Mixer, String> {
        Err("built without the feature `sound`".into())
    }

    pub(crate) fn is_broken(&self) -> bool {
        match self.0 {}
    }

    pub(crate) fn play(&mut self, _: u32, _: &Pcm, _: f32, _: f32) -> Result<(), String> {
        match self.0 {}
    }

    pub(crate) fn stop(&mut self, _: u32) {
        match self.0 {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_the_feature_a_sound_fails_as_not_supported() {
        let failure = decode(b"RIFF".to_vec(), Duration::from_secs(1)).err();
        assert!(matches!(failure, Some(Failure::Unsupported(m)) if m.contains("`sound`")));
    }
}
