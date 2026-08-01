import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
} from '@maka/core';

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

  it('shows a read-only managed boundary as read-only instead of Auto (#1611)', () => {
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface(
        'read-only',
        {
          kind: 'managed',
          profile: createReadOnlyPermissionProfile(),
          revision: 0,
        },
        'ask',
      ),
      {
        permissionMode: 'explore',
        localInteractionAvailable: true,
      },
    );
    // Once an approved expansion grants a write, the session is no longer
    // read-only and must stop claiming to be.
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface(
        'expanded',
        {
          kind: 'managed',
          profile: {
            ...createReadOnlyPermissionProfile(),
            fileSystem: {
              kind: 'restricted',
              entries: [
                { kind: 'special', access: 'read', special: ':workspace_roots' },
                { kind: 'path', access: 'write', path: '/workspace/out', match: 'subtree' },
              ],
            },
          },
          revision: 2,
        },
        'ask',
      ),
      {
        permissionMode: 'ask',
        localInteractionAvailable: true,
      },
    );
    // An intentional collapse, NOT a claim about this profile: the picker
    // offers two modes and the product does not hand out `danger-full-access`,
    // so no third label is invented for it. This is honest only because Auto's
    // copy never names a specific boundary — it says the session runs inside
    // Maka's protection layer and asks before going beyond its current
    // permissions, which is true here too. If Auto's hint ever describes a
    // concrete boundary again, this mapping turns into a false statement and
    // has to be revisited.
    assert.deepEqual(
      deriveDesktopExecutionBoundarySurface(
        'danger-full-access',
        {
          kind: 'managed',
          profile: createDangerFullAccessPermissionProfile(),
          revision: 0,
        },
        'ask',
      ),
      {
        permissionMode: 'ask',
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
