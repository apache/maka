//! Sounds in a runtime built without the feature `media` (no Media
//! Foundation or XAudio2 linked): every load and every player fails as not
//! supported, naming the feature, so the app sees `not-supported`. The same
//! items as `audio.rs`.

use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    audio::{AudioCommand, AudioError, AudioEvent},
};
use nsh_engine::EngineControl;

use crate::image::AssetBase;

/// One engine's sounds and players: none without the feature.
#[derive(Default)]
pub(crate) struct Speaker;

/// Fails every load and player: this runtime plays no sound.
pub(crate) fn command(
    _speaker: &Speaker,
    _key: u64,
    control: &EngineControl,
    command: &AudioCommand,
    _base: Option<&AssetBase>,
) {
    if matches!(
        command,
        AudioCommand::Load { .. } | AudioCommand::LoadUrl { .. } | AudioCommand::Open { .. }
    ) {
        let event = AudioEvent::Failed {
            error: AudioError::NotSupported,
            message:
                "sounds need the Windows runtime's feature `media`, which it was built without"
                    .to_owned(),
        };
        control.dispatch_event(
            ROOT_ID,
            EventKind::Audio,
            EventPayload::Audio {
                id: command.id(),
                event,
            },
        );
    }
}
