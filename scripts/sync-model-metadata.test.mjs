/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, PROVIDERS } from './sync-model-metadata.mjs';

function fixtureCatalog() {
  const catalog = {};
  for (const sourceId of new Set(Object.values(PROVIDERS))) {
    catalog[sourceId] = {
      id: sourceId,
      name: `Provider ${sourceId}`,
      doc: `https://example.test/${sourceId}`,
      models: {
        model: {
          name: 'Model',
          limit: { context: 1024, output: 128 },
          reasoning: false,
          tool_call: true,
          cost: { input: 1, output: 2 },
        },
      },
    };
  }
  catalog.unused = { id: 'unused', name: 'Unused', doc: 'https://example.test/unused', models: {} };
  return catalog;
}

test('a refresh persists the exact selected input and check fails on stale output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-snapshot-'));
  try {
    const input = join(root, 'api.json');
    const snapshot = join(root, 'snapshot.json');
    const metadata = join(root, 'metadata.ts');
    const pricing = join(root, 'pricing.ts');
    await writeFile(input, JSON.stringify(fixtureCatalog()));

    await main([
      'node',
      'sync-model-metadata.mjs',
      '--refresh',
      '--refresh-input',
      input,
      '--snapshot',
      snapshot,
      '--output',
      metadata,
      '--pricing-output',
      pricing,
    ]);

    const persisted = JSON.parse(await readFile(snapshot, 'utf8'));
    assert.equal(persisted.formatVersion, 1);
    assert.equal(persisted.origin.kind, 'models-dev-response');
    assert.equal(persisted.projection.metadata.unused, undefined);
    assert.deepEqual(
      Object.keys(persisted.projection.metadata).sort(),
      Object.keys(PROVIDERS).sort(),
    );
    assert.match(await readFile(metadata, 'utf8'), new RegExp(persisted.projectionSha256));

    await main([
      'node',
      'sync-model-metadata.mjs',
      '--check',
      '--snapshot',
      snapshot,
      '--output',
      metadata,
      '--pricing-output',
      pricing,
    ]);

    const corrected = fixtureCatalog();
    corrected.anthropic.models.model.name = 'Corrected Model';
    corrected.anthropic.models.model.cost.input = 1.5;
    await writeFile(input, JSON.stringify(corrected));
    await main([
      'node',
      'sync-model-metadata.mjs',
      '--refresh',
      '--refresh-input',
      input,
      '--snapshot',
      snapshot,
      '--output',
      metadata,
      '--pricing-output',
      pricing,
    ]);
    const correctedProjection = JSON.parse(await readFile(snapshot, 'utf8')).projection;
    assert.equal(correctedProjection.metadata.anthropic.model.displayName, 'Corrected Model');
    assert.equal(
      correctedProjection.pricing.find((entry) => entry.modelKey === 'anthropic:model')
        .inputUsdPer1M,
      1.5,
    );

    await writeFile(
      metadata,
      (await readFile(metadata, 'utf8')).replace(
        "displayName: 'Corrected Model'",
        "displayName: 'Stale'",
      ),
    );
    await assert.rejects(
      main([
        'node',
        'sync-model-metadata.mjs',
        '--check',
        '--snapshot',
        snapshot,
        '--output',
        metadata,
        '--pricing-output',
        pricing,
      ]),
      /is stale/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a modified snapshot fails closed before generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-snapshot-tamper-'));
  try {
    const input = join(root, 'api.json');
    const snapshot = join(root, 'snapshot.json');
    const metadata = join(root, 'metadata.ts');
    await writeFile(input, JSON.stringify(fixtureCatalog()));
    await main([
      'node',
      'sync-model-metadata.mjs',
      '--refresh',
      '--refresh-input',
      input,
      '--snapshot',
      snapshot,
      '--output',
      metadata,
    ]);

    const persisted = JSON.parse(await readFile(snapshot, 'utf8'));
    persisted.projection.metadata.anthropic.model.displayName = 'tampered';
    await writeFile(snapshot, JSON.stringify(persisted));
    await assert.rejects(
      main(['node', 'sync-model-metadata.mjs', '--snapshot', snapshot, '--output', metadata]),
      /digest mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refresh rejects an empty required provider before replacing outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-snapshot-empty-provider-'));
  try {
    const input = join(root, 'api.json');
    const snapshot = join(root, 'snapshot.json');
    const metadata = join(root, 'metadata.ts');
    const catalog = fixtureCatalog();
    catalog.anthropic.models = {};
    await writeFile(input, JSON.stringify(catalog));
    await writeFile(snapshot, 'old snapshot');
    await writeFile(metadata, 'old metadata');

    await assert.rejects(
      main([
        'node',
        'sync-model-metadata.mjs',
        '--refresh',
        '--refresh-input',
        input,
        '--snapshot',
        snapshot,
        '--output',
        metadata,
      ]),
      /provider anthropic has no non-empty models object/,
    );
    assert.equal(await readFile(snapshot, 'utf8'), 'old snapshot');
    assert.equal(await readFile(metadata, 'utf8'), 'old metadata');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refresh rejects unknown model modalities instead of dropping them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-snapshot-modalities-'));
  try {
    const input = join(root, 'api.json');
    const snapshot = join(root, 'snapshot.json');
    const metadata = join(root, 'metadata.ts');
    const catalog = fixtureCatalog();
    catalog.anthropic.models.model.modalities = { input: ['text', 'video'], output: ['text'] };
    await writeFile(input, JSON.stringify(catalog));

    await assert.rejects(
      main([
        'node',
        'sync-model-metadata.mjs',
        '--refresh',
        '--refresh-input',
        input,
        '--snapshot',
        snapshot,
        '--output',
        metadata,
      ]),
      /unsupported modalities/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refresh rejects a partial provider shrink until it is explicitly accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-snapshot-provider-shrink-'));
  try {
    const input = join(root, 'api.json');
    const snapshot = join(root, 'snapshot.json');
    const metadata = join(root, 'metadata.ts');
    const pricing = join(root, 'pricing.ts');
    const initial = fixtureCatalog();
    initial.anthropic.models['model-two'] = {
      name: 'Model Two',
      limit: { context: 2048, output: 256 },
      reasoning: true,
      tool_call: true,
      cost: { input: 3, output: 4 },
    };
    await writeFile(input, JSON.stringify(initial));
    const refreshArgs = [
      'node',
      'sync-model-metadata.mjs',
      '--refresh',
      '--refresh-input',
      input,
      '--snapshot',
      snapshot,
      '--output',
      metadata,
      '--pricing-output',
      pricing,
    ];
    await main(refreshArgs);
    const before = {
      snapshot: await readFile(snapshot, 'utf8'),
      metadata: await readFile(metadata, 'utf8'),
      pricing: await readFile(pricing, 'utf8'),
    };

    await writeFile(input, JSON.stringify(fixtureCatalog()));
    await assert.rejects(main(refreshArgs), /projection paths: \/metadata\/anthropic\/model-two/);
    assert.deepEqual(
      {
        snapshot: await readFile(snapshot, 'utf8'),
        metadata: await readFile(metadata, 'utf8'),
        pricing: await readFile(pricing, 'utf8'),
      },
      before,
    );

    await main([...refreshArgs, '--accept-upstream-removals']);
    const accepted = JSON.parse(await readFile(snapshot, 'utf8'));
    assert.equal(accepted.projection.metadata.anthropic['model-two'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refresh rejects lost pricing coverage from an otherwise valid model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-snapshot-pricing-shrink-'));
  try {
    const input = join(root, 'api.json');
    const snapshot = join(root, 'snapshot.json');
    const metadata = join(root, 'metadata.ts');
    const pricing = join(root, 'pricing.ts');
    const refreshArgs = [
      'node',
      'sync-model-metadata.mjs',
      '--refresh',
      '--refresh-input',
      input,
      '--snapshot',
      snapshot,
      '--output',
      metadata,
      '--pricing-output',
      pricing,
    ];
    await writeFile(input, JSON.stringify(fixtureCatalog()));
    await main(refreshArgs);
    const before = {
      snapshot: await readFile(snapshot, 'utf8'),
      metadata: await readFile(metadata, 'utf8'),
      pricing: await readFile(pricing, 'utf8'),
    };

    const truncated = fixtureCatalog();
    delete truncated.anthropic.models.model.cost;
    await writeFile(input, JSON.stringify(truncated));
    await assert.rejects(main(refreshArgs), /projection paths: \/pricing\/anthropic:model/);
    assert.deepEqual(
      {
        snapshot: await readFile(snapshot, 'utf8'),
        metadata: await readFile(metadata, 'utf8'),
        pricing: await readFile(pricing, 'utf8'),
      },
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refresh rejects nested capability and pricing shrinkage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-snapshot-nested-shrink-'));
  try {
    const input = join(root, 'api.json');
    const snapshot = join(root, 'snapshot.json');
    const metadata = join(root, 'metadata.ts');
    const pricing = join(root, 'pricing.ts');
    const refreshArgs = [
      'node',
      'sync-model-metadata.mjs',
      '--refresh',
      '--refresh-input',
      input,
      '--snapshot',
      snapshot,
      '--output',
      metadata,
      '--pricing-output',
      pricing,
    ];
    const initial = fixtureCatalog();
    initial.anthropic.models.model.modalities = {
      input: ['text', 'image'],
      output: ['text'],
    };
    initial.anthropic.models.model.reasoning = true;
    initial.anthropic.models.model.cost.cache_read = 0.25;
    await writeFile(input, JSON.stringify(initial));
    await main(refreshArgs);
    const before = {
      snapshot: await readFile(snapshot, 'utf8'),
      metadata: await readFile(metadata, 'utf8'),
      pricing: await readFile(pricing, 'utf8'),
    };

    const truncated = structuredClone(initial);
    truncated.anthropic.models.model.modalities.input = ['text'];
    delete truncated.anthropic.models.model.cost.cache_read;
    await writeFile(input, JSON.stringify(truncated));
    await assert.rejects(
      main(refreshArgs),
      (error) =>
        /\/metadata\/anthropic\/model\/modalities\/input value "image"/.test(error.message) &&
        /\/pricing\/anthropic:model\/cacheReadUsdPer1M/.test(error.message),
    );
    assert.deepEqual(
      {
        snapshot: await readFile(snapshot, 'utf8'),
        metadata: await readFile(metadata, 'utf8'),
        pricing: await readFile(pricing, 'utf8'),
      },
      before,
    );

    for (const [sourceField, projectionField] of [
      ['reasoning', 'reasoning'],
      ['tool_call', 'functionCalling'],
    ]) {
      const capabilityLoss = structuredClone(initial);
      capabilityLoss.anthropic.models.model[sourceField] = false;
      await writeFile(input, JSON.stringify(capabilityLoss));
      await assert.rejects(
        main(refreshArgs),
        new RegExp(`/metadata/anthropic/model/capabilities/${projectionField}`),
      );
      assert.deepEqual(
        {
          snapshot: await readFile(snapshot, 'utf8'),
          metadata: await readFile(metadata, 'utf8'),
          pricing: await readFile(pricing, 'utf8'),
        },
        before,
      );
    }

    const accepted = structuredClone(initial);
    accepted.anthropic.models.model.tool_call = false;
    await writeFile(input, JSON.stringify(accepted));
    await main([...refreshArgs, '--accept-upstream-removals']);
    assert.equal(
      JSON.parse(await readFile(snapshot, 'utf8')).projection.metadata.anthropic.model.capabilities
        .functionCalling,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refresh leaves all targets unchanged when any output cannot be staged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-snapshot-transaction-'));
  try {
    const input = join(root, 'api.json');
    const snapshot = join(root, 'snapshot.json');
    const metadata = join(root, 'metadata.ts');
    const pricing = join(root, 'pricing.ts');
    const missingPricing = join(root, 'missing', 'pricing.ts');
    await writeFile(input, JSON.stringify(fixtureCatalog()));
    await main([
      'node',
      'sync-model-metadata.mjs',
      '--refresh',
      '--refresh-input',
      input,
      '--snapshot',
      snapshot,
      '--output',
      metadata,
      '--pricing-output',
      pricing,
    ]);
    const before = {
      snapshot: await readFile(snapshot, 'utf8'),
      metadata: await readFile(metadata, 'utf8'),
    };

    await assert.rejects(
      main([
        'node',
        'sync-model-metadata.mjs',
        '--refresh',
        '--refresh-input',
        input,
        '--snapshot',
        snapshot,
        '--output',
        metadata,
        '--pricing-output',
        missingPricing,
      ]),
      /ENOENT/,
    );
    assert.equal(await readFile(snapshot, 'utf8'), before.snapshot);
    assert.equal(await readFile(metadata, 'utf8'), before.metadata);
    await assert.rejects(readFile(missingPricing), /ENOENT/);
    assert.deepEqual((await readdir(root)).sort(), [
      'api.json',
      'metadata.ts',
      'pricing.ts',
      'snapshot.json',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
