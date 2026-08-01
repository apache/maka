import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { voiceComposerAvailability } from '../../renderer/voice-composer-availability.js';

function voiceSettings(input?: {
  recognitionConnection?: string;
  recognitionModel?: string;
  realtimeConnection?: string;
  realtimeModel?: string;
}) {
  return {
    voice: {
      recognition: {
        connectionSlug: input?.recognitionConnection ?? '',
        model: input?.recognitionModel ?? '',
        language: '',
        prompt: '',
      },
      realtime: {
        connectionSlug: input?.realtimeConnection ?? '',
        model: input?.realtimeModel ?? '',
        voice: 'marin',
      },
    },
  };
}

describe('voiceComposerAvailability', () => {
  it('hides both composer buttons before voice models are configured', () => {
    assert.deepEqual(voiceComposerAvailability(voiceSettings()), {
      capture: false,
      realtime: false,
    });
  });

  it('requires both a connection and model for each independent voice route', () => {
    assert.deepEqual(voiceComposerAvailability(voiceSettings({
      recognitionConnection: 'speech-provider',
      recognitionModel: 'whisper-model',
    })), {
      capture: true,
      realtime: false,
    });
    assert.deepEqual(voiceComposerAvailability(voiceSettings({
      realtimeConnection: 'realtime-provider',
      realtimeModel: 'realtime-model',
    })), {
      capture: false,
      realtime: true,
    });
  });

  it('does not treat whitespace-only voice settings as configured', () => {
    assert.deepEqual(voiceComposerAvailability(voiceSettings({
      recognitionConnection: ' ',
      recognitionModel: 'model',
      realtimeConnection: 'provider',
      realtimeModel: '\t',
    })), {
      capture: false,
      realtime: false,
    });
  });
});
