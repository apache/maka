import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deriveModelSwitchTranscript, type StoredMessage } from '../session.js';

describe('deriveModelSwitchTranscript', () => {
  it('treats any durable transcript as an existing conversation', () => {
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'hello',
      },
    ];

    assert.deepEqual(deriveModelSwitchTranscript(messages), {
      hasConversation: true,
    });
  });

  it('uses the latest assistant model as the actual baseline', () => {
    const messages: StoredMessage[] = [
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'first',
        modelId: 'model-a',
      },
      {
        type: 'assistant',
        id: 'assistant-2',
        turnId: 'turn-2',
        ts: 2,
        text: 'second',
        modelId: 'model-b',
      },
    ];

    assert.deepEqual(deriveModelSwitchTranscript(messages), {
      hasConversation: true,
      lastUsedModel: 'model-b',
    });
  });
});
