import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ARTIFACT_ENTITY_ID_MAX_CHARS, isCanonicalArtifactEntityId } from '../artifacts.js';

describe('canonical Artifact entity identity', () => {
  test('accepts the shared ASCII grammar through the 128-character boundary', () => {
    assert.equal(ARTIFACT_ENTITY_ID_MAX_CHARS, 128);
    assert.equal(isCanonicalArtifactEntityId('Artifact_01-session'), true);
    assert.equal(isCanonicalArtifactEntityId('a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS)), true);
  });

  test('rejects values outside the canonical grammar', () => {
    for (const value of [
      '',
      'a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS + 1),
      '.',
      'artifact.id',
      'artifact/id',
      'artifact\\id',
      'artifact id',
      'artifact\nid',
      '\0artifact',
      1,
      null,
    ]) {
      assert.equal(isCanonicalArtifactEntityId(value), false, JSON.stringify(value));
    }
  });
});
