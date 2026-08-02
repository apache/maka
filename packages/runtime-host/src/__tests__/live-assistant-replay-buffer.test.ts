import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveAssistantReplayBuffer } from '../server/live-assistant-replay-buffer.js';

test('live assistant replay coalesces tiny deltas while retaining a bounded tail', () => {
  const buffer = new LiveAssistantReplayBuffer({
    maxRawBytes: 64,
    maxWireBytes: 80,
    maxChunkRawBytes: 8,
    maxChunkWireBytes: 10,
  });

  for (let index = 0; index < 1_000; index += 1) buffer.append('x');

  assert.equal(buffer.value(), 'x'.repeat(64));
  assert.ok(buffer.retainedChunkCount <= 8);
});

test('live assistant replay trims escaped Unicode text at code-point boundaries', () => {
  const buffer = new LiveAssistantReplayBuffer({
    maxRawBytes: 8,
    maxWireBytes: 9,
    maxChunkRawBytes: 8,
    maxChunkWireBytes: 9,
  });

  buffer.append('prefix\n🙂x');

  assert.equal(buffer.value(), 'ix\n🙂x');
  assert.equal(Buffer.byteLength(buffer.value(), 'utf8'), 8);
  assert.equal(buffer.wireBytes, 9);
});
