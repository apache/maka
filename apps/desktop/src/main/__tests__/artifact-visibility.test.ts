import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArtifactRecord, ArtifactSource } from '@maka/core';
import { filterUserVisibleArtifacts } from '../../renderer/artifact-visibility.js';

function artifact(source?: ArtifactSource): ArtifactRecord {
  return {
    id: source ?? 'legacy',
    sessionId: 'session-1',
    turnId: 'turn-1',
    source,
    kind: 'file',
    name: `${source ?? 'legacy'}.json`,
    relativePath: `${source ?? 'legacy'}.json`,
    sizeBytes: 4096,
    createdAt: 1,
    status: 'live',
  };
}

describe('generated artifact visibility', () => {
  it('excludes runtime context state and user-upload snapshots', () => {
    const hiddenSources: ArtifactSource[] = [
      'synthesis_cache_block',
      'history_compact_block',
      'history_compact_source',
      'provider_request_capture',
      'user_upload',
    ];

    assert.deepEqual(filterUserVisibleArtifacts(hiddenSources.map(artifact)), []);
  });

  it('preserves user-facing generated files and legacy records without a source', () => {
    const visibleSources: Array<ArtifactSource | undefined> = [
      'tool_result',
      'tool_result_archive',
      'deep_research',
      'export',
      'snapshot',
      'fixture',
      undefined,
    ];
    const records = visibleSources.map(artifact);

    assert.deepEqual(filterUserVisibleArtifacts(records), records);
  });
});
