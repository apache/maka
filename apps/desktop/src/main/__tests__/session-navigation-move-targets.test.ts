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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ProjectRecord } from '@maka/core/project';
import {
  deriveSessionNavigationGroups,
  sessionMoveTargets,
  type SessionNavigationProjectScope,
  type SessionNavigationSession,
} from '../../renderer/features/session-navigation/testing.js';

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: id,
    locations: [{ path: `/${id}`, isWorktree: false }],
    available: true,
    preferredPath: `/${id}`,
    ...overrides,
  };
}

function scope(
  hostId: string,
  key: string,
  proj: ProjectRecord,
): SessionNavigationProjectScope {
  return {
    key,
    profileId: `profile-${key}`,
    hostId,
    profileName: key,
    profileKind: 'local',
    project: proj,
    capabilities: { chooseClientDirectory: false },
  };
}

function session(
  id: string,
  overrides: Partial<SessionNavigationSession> = {},
): SessionNavigationSession {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'ask',
    runtimeHostId: 'local',
    profileId: 'profile-local',
    profileName: 'local',
    profileKind: 'local',
    ...overrides,
  };
}

describe('sessionMoveTargets', () => {
  const homes: Array<{ name: string; projectId: string; overrides: Partial<ProjectRecord> }> = [
    { name: 'active', projectId: 'pA', overrides: {} },
    { name: 'alias', projectId: 'oldA', overrides: { aliases: ['oldA'] } },
    { name: 'archived', projectId: 'pA', overrides: { archivedAt: 1 } },
    { name: 'archived alias', projectId: 'oldA', overrides: { archivedAt: 1, aliases: ['oldA'] } },
    { name: 'unavailable', projectId: 'pA', overrides: { available: false } },
  ];

  for (const home of homes) {
    it('keeps membership and an exit for an ' + home.name + ' project', () => {
      const current = session('s1', { projectId: home.projectId });
      const homeScope = scope('local', 'keyA', project('pA', home.overrides));
      const scopes = [homeScope, scope('local', 'keyB', project('pB'))];
      const groups = deriveSessionNavigationGroups([current], scopes, 'en');
      assert.equal(groups.find((group) => group.sessions.includes(current))?.id, 'project:keyA');
      assert.deepEqual(sessionMoveTargets(current, scopes), [
        { groupKey: 'project:keyB', projectId: 'pB', name: 'pB' },
        { groupKey: '__ungrouped__:local', projectId: null },
      ]);
      assert.deepEqual(
        sessionMoveTargets(current, [homeScope]),
        [{ groupKey: '__ungrouped__:local', projectId: null }],
        'leaving a known project does not require another destination',
      );
    });
  }

  for (const projectId of [undefined, null, 'missing']) {
    it('offers only destinations without known membership: ' + String(projectId), () => {
      const current = session('s1', { projectId });
      assert.deepEqual(
        sessionMoveTargets(current, [
          scope('local', 'keyB', project('pB')),
          scope('local', 'keyC', project('pC')),
        ]).map((target) => target.projectId),
        ['pB', 'pC'],
      );
      assert.deepEqual(sessionMoveTargets(current, []), []);
    });
  }

  for (const remoteProject of [project('pR'), project('remote', { aliases: ['pR'] })]) {
    it('ignores membership and destinations on another Host: ' + remoteProject.id, () => {
      const targets = sessionMoveTargets(
        session('s1', { projectId: 'pR' }),
        [scope('remote', 'keyR', remoteProject), scope('local', 'keyL', project('pL'))],
      );
      assert.deepEqual(targets, [{ groupKey: 'project:keyL', projectId: 'pL', name: 'pL' }]);
    });
  }

  it('does not offer archived or unavailable projects as destinations', () => {
    const targets = sessionMoveTargets(
      session('s1'),
      [
        scope('local', 'keyA', project('pA', { available: false })),
        scope('local', 'keyB', project('pB')),
        scope('local', 'keyC', project('pC', { archivedAt: 1 })),
      ],
    );
    assert.deepEqual(targets, [{ groupKey: 'project:keyB', projectId: 'pB', name: 'pB' }]);
  });
});
