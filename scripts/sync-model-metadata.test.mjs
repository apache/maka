import assert from 'node:assert/strict';
import test from 'node:test';

import { toMetadata } from './sync-model-metadata.mjs';

const PROVIDER = { doc: 'https://example.com/docs' };
const BASE_MODEL = {
  name: 'Test Model',
  limit: { context: 128_000, output: 8_192 },
  reasoning: true,
  tool_call: true,
};

test('models.dev reasoning_options effort values pass through to thinkingOptions', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, {
    ...BASE_MODEL,
    reasoning_options: [{ type: 'effort', values: ['high', 'max'] }],
  });
  assert.deepEqual(metadata.thinkingOptions, { efforts: ['high', 'max'] });
});

test('models.dev reasoning_options toggle passes through to thinkingOptions', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, {
    ...BASE_MODEL,
    reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }],
  });
  assert.deepEqual(metadata.thinkingOptions, { efforts: ['low', 'high'], toggle: true });
});

test('models without reasoning_options declare no thinkingOptions', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, BASE_MODEL);
  assert.equal('thinkingOptions' in metadata, false);
});

test('an empty reasoning_options list declares no thinkingOptions', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, { ...BASE_MODEL, reasoning_options: [] });
  assert.equal('thinkingOptions' in metadata, false);
});

test('malformed reasoning_options are rejected as an unsupported shape', () => {
  assert.throws(
    () => toMetadata('test', 'm', PROVIDER, { ...BASE_MODEL, reasoning_options: 'effort' }),
    /unsupported shape/,
  );
  assert.throws(
    () =>
      toMetadata('test', 'm', PROVIDER, {
        ...BASE_MODEL,
        reasoning_options: [{ type: 'effort', values: 'high' }],
      }),
    /unsupported shape/,
  );
});
