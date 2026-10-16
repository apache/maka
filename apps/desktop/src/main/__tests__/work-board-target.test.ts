/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

  test('rejects archived and ambiguous projects', () => {
    const archived = resolveWorkBoardStartTarget(
      item({ kind: 'project', projectId: 'old-project-id' }),
      catalog([{ id: 'canonical-project', aliases: ['old-project-id'], name: 'Project', locations: [], available: true, archivedAt: 10 }]),
    );
    assert.equal(archived.ok ? 'unexpected' : archived.reason, 'unavailable');

    const shared = { id: 'p1', aliases: ['shared-id'], name: 'Project', locations: [], available: true };
    const multiHost: TaskEntryCatalog = {
      defaultProfileId: 'profile-1',
      hosts: [
        {
          profile: { id: 'profile-1', name: 'Local', kind: 'local' },
          hostId: 'host-1',
          readiness: 'ready',
          state: 'available',
          projects: [shared],
          capabilities: { chooseClientDirectory: false, chooseHostDirectory: false, selectNoProject: true },
          selectedProjectId: null,
          chatDefaults: { permissionMode: 'ask', thinkingLevel: 'off' },
        },
        {
          profile: { id: 'profile-2', name: 'Remote', kind: 'remote' },
          hostId: 'host-2',
          readiness: 'ready',
          state: 'available',
          projects: [{ ...shared, id: 'p2' }],
          capabilities: { chooseClientDirectory: false, chooseHostDirectory: false, selectNoProject: true },
          selectedProjectId: null,
          chatDefaults: { permissionMode: 'ask', thinkingLevel: 'off' },
        },
      ],
    };
    const ambiguous = resolveWorkBoardStartTarget(item({ kind: 'project', projectId: 'shared-id' }), multiHost);
    assert.equal(ambiguous.ok ? 'unexpected' : ambiguous.reason, 'ambiguous');
  });
});
