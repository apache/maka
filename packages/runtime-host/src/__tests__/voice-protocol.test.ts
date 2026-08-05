import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultVoiceSettings } from '@maka/core';
import {
  decodeRequestFrame,
  decodeResponseFrame,
  VOICE_PAYLOAD_CHUNK_MAX_BYTES,
} from '../protocol/index.js';

test('Voice protocol keeps settings exact and payload chunks bounded', () => {
  const begin = decodeRequestFrame({
    requestId: 'request-1',
    operation: 'voice.capture.begin',
    input: {
      request: { intent: 'dictate' },
      settings: defaultVoiceSettings(),
    },
  });
  assert.equal(begin.operation, 'voice.capture.begin');
  assert.throws(() =>
    decodeRequestFrame({
      requestId: 'request-2',
      operation: 'voice.capture.begin',
      input: {
        request: { intent: 'dictate' },
        settings: { ...defaultVoiceSettings(), secret: 'must-not-cross-wire' },
      },
    }),
  );

  const chunk = Buffer.alloc(VOICE_PAYLOAD_CHUNK_MAX_BYTES, 3).toString('base64');
  assert.equal(
    decodeRequestFrame({
      requestId: 'request-3',
      operation: 'voice.payload.append',
      input: { operationId: 'operation-1', offset: 0, chunk },
    }).operation,
    'voice.payload.append',
  );
  assert.throws(() =>
    decodeRequestFrame({
      requestId: 'request-4',
      operation: 'voice.payload.append',
      input: {
        operationId: 'operation-1',
        offset: 0,
        chunk: Buffer.alloc(VOICE_PAYLOAD_CHUNK_MAX_BYTES + 1, 3).toString('base64'),
      },
    }),
  );
});

test('Voice protocol accepts voice-only Turn input and closed result variants', () => {
  const operationId = '123e4567-e89b-12d3-a456-426614174000';
  const turn = decodeRequestFrame({
    requestId: 'request-1',
    operation: 'turn.start',
    input: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      content: { text: '' },
      voiceOperationId: operationId,
    },
  });
  assert.equal(turn.operation, 'turn.start');
  if (turn.operation === 'turn.start') assert.equal(turn.input.voiceOperationId, operationId);
  assert.equal(
    decodeResponseFrame({
      requestId: 'request-2',
      operation: 'voice.capture.finish',
      ok: true,
      result: {
        kind: 'native_audio_ready',
        operationId,
        providerLabel: 'Provider',
      },
    }).operation,
    'voice.capture.finish',
  );
  assert.throws(() =>
    decodeResponseFrame({
      requestId: 'request-3',
      operation: 'voice.capture.finish',
      ok: true,
      result: {
        kind: 'native_audio_ready',
        operationId,
        providerLabel: 'Provider',
        credential: 'must-not-cross-wire',
      },
    }),
  );
});
