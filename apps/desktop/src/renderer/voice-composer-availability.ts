import type { AppSettings } from '@maka/core';

/** The composer voice-capture control exists only after its route has a usable target. */
export function voiceComposerAvailability(
  voice: Pick<AppSettings['voice'], 'recognition'>,
): {
  capture: boolean;
} {
  return {
    capture: Boolean(
      voice.recognition.connectionSlug.trim()
      && voice.recognition.model.trim(),
    ),
  };
}
