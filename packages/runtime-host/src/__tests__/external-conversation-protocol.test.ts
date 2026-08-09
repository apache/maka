import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EXTERNAL_CONVERSATION_OPERATION_SPECS } from '../protocol/external-conversation.js';

const reconcile = EXTERNAL_CONVERSATION_OPERATION_SPECS['external-conversation.reconcile'];

describe('external-conversation protocol', () => {
  test('decodes resolve and release without accepting a Client-selected Session id', () => {
    assert.deepEqual(
      reconcile.decodeInput({
        kind: 'resolve',
        conversationId: 'slack:channel:C1:thread:123.456',
        session: {
          cwd: '/workspace',
          name: 'Slack thread',
          labels: ['bot', 'slack'],
          modelTarget: { kind: 'default' },
          permissionMode: 'explore',
        },
      }),
      {
        kind: 'resolve',
        conversationId: 'slack:channel:C1:thread:123.456',
        session: {
          cwd: '/workspace',
          name: 'Slack thread',
          labels: ['bot', 'slack'],
          modelTarget: { kind: 'default' },
          permissionMode: 'explore',
        },
      },
    );
    assert.deepEqual(
      reconcile.decodeInput({
        kind: 'release',
        conversationId: 'slack:channel:C1:thread:123.456',
        operationId: 'bot_reset_1',
      }),
      {
        kind: 'release',
        conversationId: 'slack:channel:C1:thread:123.456',
        operationId: 'bot_reset_1',
      },
    );

    assert.throws(() =>
      reconcile.decodeInput({
        kind: 'resolve',
        conversationId: 'telegram:chat-1',
        session: {
          sessionId: 'client-selected',
          cwd: '/workspace',
          modelTarget: { kind: 'default' },
        },
      }),
    );
  });

  test('keeps release retries entity-safe and the conversation identity bounded', () => {
    assert.throws(() =>
      reconcile.decodeInput({
        kind: 'release',
        conversationId: 'telegram:chat-1',
        operationId: 'contains:transport:punctuation',
      }),
    );
    assert.throws(() =>
      reconcile.decodeInput({
        kind: 'release',
        conversationId: 'x'.repeat(4 * 1024 + 1),
        operationId: 'bot_reset_1',
      }),
    );
  });
});
