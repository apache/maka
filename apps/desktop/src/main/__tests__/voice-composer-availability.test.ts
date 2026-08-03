import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { voiceComposerAvailability } from '../../renderer/voice-composer-availability.js';

function voiceConfig(input?: {
  recognitionConnection?: string;
  recognitionModel?: string;
}) {
  return {
    recognition: {
      connectionSlug: input?.recognitionConnection ?? '',
      model: input?.recognitionModel ?? '',
      language: '',
      prompt: '',
    },
  };
}

describe('voiceComposerAvailability', () => {
  it('hides the composer voice-capture button before voice models are configured', () => {
    assert.deepEqual(voiceComposerAvailability(voiceConfig()), {
      capture: false,
    });
  });

  it('requires both a connection and model for the voice route', () => {
    assert.deepEqual(voiceComposerAvailability(voiceConfig({
      recognitionConnection: 'speech-provider',
      recognitionModel: 'whisper-model',
    })), {
      capture: true,
    });
    assert.deepEqual(voiceComposerAvailability(voiceConfig({
      recognitionConnection: 'speech-provider',
    })), {
      capture: false,
    });
  });

  it('does not treat whitespace-only voice settings as configured', () => {
    assert.deepEqual(voiceComposerAvailability(voiceConfig({
      recognitionConnection: ' ',
      recognitionModel: 'model',
    })), {
      capture: false,
    });
  });
});
