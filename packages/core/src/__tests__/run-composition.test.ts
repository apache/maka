import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRunCompositionSnapshot,
  decodeRunCompositionSnapshot,
  RUN_COMPOSITION_SCHEMA_VERSION,
} from '../run-composition.js';

test('Run Composition snapshots are canonical immutable execution facts', () => {
  const sourceRevisions = [
    { id: 'skill-catalog', revision: 'skills-2' },
    { id: 'runtime-policy', revision: '4' },
    { id: 'memory', revision: 'memory-3' },
  ];
  const toolNames = ['Write', 'Read'];
  const snapshot = createRunCompositionSnapshot({
    composerId: 'maka.interactive',
    composerRevision: '1',
    sourceRevisions,
    baseSystemPromptHash: hash('1'),
    toolCatalogHash: hash('2'),
    toolAvailabilityHash: hash('3'),
    baseProviderOptionsHash: hash('4'),
    toolNames,
    contextWindow: 128_000,
  });

  sourceRevisions[0]!.revision = 'late-revision';
  toolNames.push('LateTool');
  assert.deepEqual(snapshot.sourceRevisions, [
    { id: 'memory', revision: 'memory-3' },
    { id: 'runtime-policy', revision: '4' },
    { id: 'skill-catalog', revision: 'skills-2' },
  ]);
  assert.deepEqual(snapshot.toolNames, ['Read', 'Write']);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.sourceRevisions));
  assert.ok(Object.isFrozen(snapshot.sourceRevisions[0]));
  assert.ok(Object.isFrozen(snapshot.toolNames));
});

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
