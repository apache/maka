import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createGenesisExecutionBoundary } from '../sandbox-boundary.js';

describe('deep research session profile', () => {
  it('gives explore sessions a managed read-only filesystem and restricted network', () => {
    const boundary = createGenesisExecutionBoundary('explore');
    assert.equal(boundary.kind, 'managed');
    if (boundary.kind !== 'managed') return;
    assert.equal(boundary.profile.name, 'read-only');
    assert.deepEqual(boundary.profile.fileSystem, {
      kind: 'restricted',
      entries: [{ kind: 'special', access: 'read', special: ':workspace_roots' }],
    });
    assert.equal(boundary.profile.network.kind, 'restricted');
  });
});
