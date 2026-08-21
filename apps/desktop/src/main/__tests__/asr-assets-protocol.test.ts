import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  senseVoiceAssetNameFromUrl,
  serveSenseVoiceAsset,
} from '../asr-assets-protocol.js';

describe('SenseVoice asset protocol', () => {
  it('accepts only the fixed bundle host and allowlisted assets', () => {
    assert.equal(
      senseVoiceAssetNameFromUrl('maka-asr://bundle/model.int8.onnx'),
      'model.int8.onnx',
    );
    assert.equal(senseVoiceAssetNameFromUrl('maka-asr://other/model.int8.onnx'), undefined);
    assert.equal(senseVoiceAssetNameFromUrl('maka-asr://bundle/../secret'), undefined);
    assert.equal(senseVoiceAssetNameFromUrl('file:///model.int8.onnx'), undefined);
  });

  it('streams an installed asset with its expected content type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-asr-protocol-'));
    await writeFile(join(root, 'tokens.txt'), 'hello 1\n');

    const response = await serveSenseVoiceAsset('maka-asr://bundle/tokens.txt', root);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response.text(), 'hello 1\n');
  });

  it('does not disclose missing paths', async () => {
    const response = await serveSenseVoiceAsset(
      'maka-asr://bundle/model.int8.onnx',
      join(tmpdir(), 'maka-asr-missing'),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes(tmpdir()), false);
  });
});
