import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ARTIFACT_ENTITY_ID_MAX_CHARS,
  ARTIFACT_SOURCES,
  ARTIFACT_TURN_KEY_MAX_CHARS,
  type ArtifactSource,
  canUserDeleteArtifact,
  isArtifactTurnKey,
  isCanonicalArtifactEntityId,
} from '../artifacts.js';

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

describe('Artifact turn key', () => {
  test('accepts bounded opaque turn keys without coupling to synthetic namespaces', () => {
    assert.equal(isArtifactTurnKey('turn-1'), true);
    assert.equal(isArtifactTurnKey('history-compact:0'), true);
    assert.equal(isArtifactTurnKey('synthesis-cache:1.5'), true);
    assert.equal(isArtifactTurnKey('future-runtime-kind:sequence/branch'), true);
    assert.equal(isArtifactTurnKey('回合:一'), true);
    assert.equal(isArtifactTurnKey('x'.repeat(ARTIFACT_TURN_KEY_MAX_CHARS)), true);
  });

  test('rejects empty, unbounded, and control-bearing turn keys', () => {
    for (const value of [
      '',
      'turn\n1',
      'turn\t1',
      'turn\u007f1',
      'x'.repeat(ARTIFACT_TURN_KEY_MAX_CHARS + 1),
      null,
    ]) {
      assert.equal(isArtifactTurnKey(value), false, JSON.stringify(value));
    }
  });
});

describe('Artifact user-delete policy', () => {
  test('makes every source decision explicit and protects durable evidence', () => {
    const protectedSources = new Set<ArtifactSource>(['deep_research', 'tool_result_archive']);
    for (const source of ARTIFACT_SOURCES) {
      assert.equal(canUserDeleteArtifact({ source }), !protectedSources.has(source), source);
    }
    assert.equal(canUserDeleteArtifact({ source: undefined }), true);
  });
});
