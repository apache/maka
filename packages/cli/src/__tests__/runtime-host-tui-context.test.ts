import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeHostConnection, RuntimeHostProfile } from '@maka/runtime-host/client';
import { resolveRuntimeHostTuiWorkspace } from '../runtime-host-tui-context.js';

const REMOTE_PROFILE: RuntimeHostProfile = {
  id: 'office',
  name: 'Office',
  kind: 'remote',
  transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
  rootId: 'a'.repeat(64),
};

describe('Runtime Host TUI workspace selection', () => {
  test('requires an existing Host Project for a new remote Session', async () => {
    await assert.rejects(
      () => resolveRuntimeHostTuiWorkspace({} as RuntimeHostConnection, REMOTE_PROFILE, {}),
      /requires --project/,
    );
  });

  test('canonicalizes a remote Project alias without reading a Client path', async () => {
    const connection = {
      request: async (operation: string) => {
        assert.equal(operation, 'project.catalog.query');
        return {
          kind: 'page',
          view: 'summary',
          revision: `sha256:${'1'.repeat(64)}`,
          projectCount: 1,
          items: [
            {
              kind: 'project',
              projectIndex: 0,
              id: 'project-1',
              name: 'Project',
              aliasCount: 1,
              locationCount: 1,
              preferredLocationIndex: 0,
              archivedAt: null,
              available: true,
            },
            {
              kind: 'alias',
              projectIndex: 0,
              itemIndex: 0,
              alias: 'project-old',
            },
          ],
          nextCursor: null,
        };
      },
    } as unknown as RuntimeHostConnection;

    assert.deepEqual(
      await resolveRuntimeHostTuiWorkspace(connection, REMOTE_PROFILE, {
        projectId: 'project-old',
      }),
      { kind: 'project', projectId: 'project-1' },
    );
  });
});
