import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkspaceWritePermissionProfile } from '@maka/core';

import { deriveDesktopExecutionBoundarySurface } from '../../renderer/desktop-execution-boundary-surface.js';

describe('Desktop execution boundary surface', () => {
  it('projects managed and bypass boundaries to their user-facing controls', () => {
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface(
        'managed',
        {
          kind: 'managed',
          profile: createWorkspaceWritePermissionProfile(),
          revision: 0,
        },
        'bypass',
      ),
      {
        permissionMode: 'ask',
        localInteractionAvailable: true,
      },
    );
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface(
        'bypass',
        { kind: 'bypass', revision: 1 },
        'ask',
      ),
      {
        permissionMode: 'bypass',
        localInteractionAvailable: true,
      },
    );
  });

  it('fails closed while authority is loading and keeps External history non-interactive', () => {
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface('loading', undefined, 'ask'),
      {
        permissionMode: undefined,
        localInteractionAvailable: false,
      },
    );
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface(
        'external',
        { kind: 'external', revision: 0 },
        'ask',
      ),
      {
        permissionMode: undefined,
        localInteractionAvailable: false,
      },
    );
  });
});
