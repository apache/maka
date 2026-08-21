import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  measurePcmLevel,
  mergePcmChunks,
  resamplePcm,
} from '../../renderer/voice-input/pcm-recorder.js';

describe('PCM microphone helpers', () => {
  it('merges chunks without dropping their boundary samples', () => {
    assert.deepEqual(
      [...mergePcmChunks([new Float32Array([1, 2]), new Float32Array([3])])],
      [1, 2, 3],
    );
  });

  it('downsamples 48 kHz PCM to 16 kHz by averaging source coverage', () => {
    assert.deepEqual(
      [...resamplePcm(new Float32Array([0, 1, 2, 3, 4, 5]), 48_000, 16_000)],
      [1, 4],
    );
  });

  it('maps microphone RMS to a bounded waveform level', () => {
    assert.equal(measurePcmLevel(new Float32Array()), 0);
    assert.ok(Math.abs(measurePcmLevel(new Float32Array([0.05, -0.05])) - 0.6) < 0.000_001);
    assert.equal(measurePcmLevel(new Float32Array([1, -1])), 1);
  });
});
