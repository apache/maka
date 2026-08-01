import type { AppSettings } from '@maka/core';

/** Composer voice controls exist only after their route has a usable target. */
export function voiceComposerAvailability(settings: Pick<AppSettings, 'voice'>): {
  capture: boolean;
  realtime: boolean;
} {
  return {
    capture: Boolean(
      settings.voice.recognition.connectionSlug.trim()
      && settings.voice.recognition.model.trim(),
    ),
    realtime: Boolean(
      settings.voice.realtime.connectionSlug.trim()
      && settings.voice.realtime.model.trim(),
    ),
  };
}
