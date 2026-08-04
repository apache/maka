import assert from 'node:assert/strict';
import test from 'node:test';

import { toMetadata, PROVIDERS } from './sync-model-metadata.mjs';

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

test('a toggle-only model declares thinkingOptions without efforts', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, {
    ...BASE_MODEL,
    reasoning_options: [{ type: 'toggle' }],
  });
  assert.deepEqual(metadata.thinkingOptions, { toggle: true });
});

test('budget_tokens is recognized and skipped until a wire consumes it', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, {
    ...BASE_MODEL,
    reasoning_options: [{ type: 'budget_tokens' }, { type: 'effort', values: ['high'] }],
  });
  assert.deepEqual(metadata.thinkingOptions, { efforts: ['high'] });
});

test('an unknown reasoning_options type fails loudly instead of drifting', () => {
  assert.throws(
    () =>
      toMetadata('test', 'm', PROVIDER, {
        ...BASE_MODEL,
        reasoning_options: [{ type: 'mystery' }],
      }),
    /unsupported shape/,
  );
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

test('main() syncs only the mapped providers into the generated snapshot', async () => {
  // End-to-end over the real main() path (the place the kimi/stepfun orphan
  // bug lived): a fixture catalog covering every mapped source id plus one
  // unmapped neighbour; only the mapped ones may produce segments.
  const catalog = {};
  for (const sourceId of Object.values(PROVIDERS)) {
    catalog[sourceId] = {
      id: sourceId,
      name: sourceId,
      doc: `https://${sourceId}.example/docs`,
      api: `https://${sourceId}.example/v1`,
      models: {},
    };
  }
  catalog['kimi-for-coding'].api = 'https://api.kimi.com/coding/v1';
  catalog['kimi-for-coding'].models.k3 = {
    name: 'Kimi K3',
    limit: { context: 1_048_576, output: 131_072 },
    reasoning: true,
    tool_call: true,
    reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
  };
  catalog['unmapped-provider'] = {
    id: 'unmapped-provider',
    name: 'Unmapped',
    doc: 'https://example.com/docs',
    api: 'https://unmapped.example/v1',
    models: {
      'm-1': {
        name: 'M1',
        limit: { context: 8_192, output: 4_096 },
        reasoning: false,
        tool_call: true,
      },
    },
  };
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'maka-sync-'));
  const input = join(dir, 'catalog.json');
  const output = join(dir, 'out.ts');
  await writeFile(input, JSON.stringify(catalog));
  const { main } = await import('./sync-model-metadata.mjs');
  await main(['--input', input, '--output', output]);
  const out = await readFile(output, 'utf8');
  await rm(dir, { recursive: true, force: true });

  assert.match(out, /"kimi-coding-plan": \{/);
  assert.match(out, /"k3": \{/);
  assert.match(out, /"thinkingOptions":\{"efforts":\["low","high","max"\],"toggle":true\}/);
  assert.match(out, /"kimi-for-coding": \{/);
  assert.match(out, /"kimi-for-coding": \{"api":"https:\/\/api\.kimi\.com\/coding\/v1"\}/);
  // The unmapped provider must appear only in the directory (the complete
  // upstream catalog), never as a snapshot segment or provider fact.
  const directoryStart = out.indexOf('GENERATED_MODELS_DEV_DIRECTORY');
  assert.ok(directoryStart > 0);
  assert.doesNotMatch(out.slice(0, directoryStart), /unmapped-provider/);
  assert.match(out.slice(directoryStart), /"unmapped-provider": \{/);
});
