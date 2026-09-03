import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveWorkBoardStartTarget } from '../../renderer/features/task-entry/testing.js';
import type { TaskEntryCatalog } from '../../renderer/features/task-entry/testing.js';
import type { ProjectRecord } from '@maka/core/project';
import type { WorkBoardItem } from '@maka/core/work-board';

const item = (scope: WorkBoardItem['scope']): WorkBoardItem => ({
  schemaVersion: 1,
  id: 'item-1',
  revision: 1,
  scope,
  title: 'Review auth',
  state: 'todo',
  archived: false,
  creator: { kind: 'user' },
  provenance: { kind: 'manual' },
  linkedSessions: [],
  createdAt: 1,
  updatedAt: 1,
});

const catalog = (projects: readonly ProjectRecord[]): TaskEntryCatalog => ({
  defaultProfileId: 'profile-1',
  hosts: [{
    profile: { id: 'profile-1', name: 'Local', kind: 'local' },
    hostId: 'host-1',
    readiness: 'ready',
    state: 'available',
    projects,
    capabilities: { chooseClientDirectory: false, chooseHostDirectory: false, selectNoProject: true },
    selectedProjectId: null,
    chatDefaults: { permissionMode: 'ask', thinkingLevel: 'off' },
  }],
});

describe('Work Board Start task target resolution', () => {
  test('resolves an available project alias to a canonical Host target', () => {
    const result = resolveWorkBoardStartTarget(
      item({ kind: 'project', projectId: 'old-project-id' }),
      catalog([{ id: 'canonical-project', aliases: ['old-project-id'], name: 'Project', locations: [], available: true }]),
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.target, { profileId: 'profile-1', hostId: 'host-1', projectId: 'canonical-project' });
  });

  test('rejects Inbox and unavailable projects', () => {
    const inbox = resolveWorkBoardStartTarget(item({ kind: 'inbox' }), catalog([]));
    const missing = resolveWorkBoardStartTarget(item({ kind: 'project', projectId: 'missing' }), catalog([]));
    assert.equal(inbox.ok ? 'unexpected' : inbox.reason, 'inbox');
    assert.equal(missing.ok ? 'unexpected' : missing.reason, 'unavailable');
  });
});
