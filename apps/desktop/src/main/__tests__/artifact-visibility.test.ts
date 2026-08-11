import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArtifactRecord, ArtifactSource } from '@maka/core/artifacts';
import { filterUserVisibleArtifacts } from '../../renderer/artifact-visibility.js';

function artifact(source: ArtifactSource): ArtifactRecord {
  return {
    id: source,
    sessionId: 'session-1',
    turnId: 'turn-1',
    source,
    kind: 'file',
    name: `${source}.json`,
    relativePath: `${source}.json`,
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
      'session_effect',
      'user_upload',
    ];

    assert.deepEqual(filterUserVisibleArtifacts(hiddenSources.map(artifact)), []);
  });

  it('excludes generic tool traces from generated files', () => {
    const hiddenSources: ArtifactSource[] = [
      'tool_result',
      'tool_result_archive',
    ];

    assert.deepEqual(filterUserVisibleArtifacts(hiddenSources.map(artifact)), []);
  });

  it('preserves user-facing generated files', () => {
    const visibleSources: ArtifactSource[] = [
      'subagent_writeback',
      'deep_research',
      'export',
      'snapshot',
      'fixture',
    ];
    const records = visibleSources.map(artifact);

    assert.deepEqual(filterUserVisibleArtifacts(records), records);
  });
});
