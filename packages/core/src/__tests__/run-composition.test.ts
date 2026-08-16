import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeRunCompositionSnapshot,
  RUN_COMPOSITION_SCHEMA_VERSION,
} from '../run-composition.js';

test('Run Composition snapshots reject ambiguous toolsets and malformed hashes', () => {
  const valid = {
    schemaVersion: RUN_COMPOSITION_SCHEMA_VERSION,
    composerId: 'maka.interactive',
    composerRevision: '1',
    sourceRevisions: [{ id: 'skill-catalog', revision: 'skills-0' }],
    baseSystemPromptHash: hash('1'),
    toolCatalogHash: hash('2'),
    toolAvailabilityHash: hash('3'),
    baseProviderOptionsHash: hash('4'),
    toolNames: ['Read'],
    contextWindow: null,
  };

  for (const candidate of [
    { ...valid, baseSystemPromptHash: 'sha256:short' },
    { ...valid, toolNames: ['Write', 'Read'] },
    { ...valid, toolNames: ['Read', 'Read'] },
    {
      ...valid,
      sourceRevisions: [
        { id: 'skill-catalog', revision: 'skills-0' },
        { id: 'runtime-policy', revision: '1' },
      ],
    },
    { ...valid, sourceRevisions: [{ id: 'skill-catalog', revision: '' }] },
  ]) {
    assert.throws(() => decodeRunCompositionSnapshot(candidate));
  }
});

function hash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`;
}
