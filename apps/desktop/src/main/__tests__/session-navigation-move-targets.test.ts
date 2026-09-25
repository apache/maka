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

/**
 * The destination list the rail's "move to project" menu reads for one task.
 *
 * Two questions live here, and they used to be answered by different halves of
 * the truth: which projects may the task land in (one Host's available,
 * un-archived scopes), and may "leave every project" ride along (the task's
 * `projectId` was truthy). A task whose `projectId` had outlived its Project —
 * deleted, relocated, archived upstream — satisfied the second while failing
 * the first, and its menu offered only the exit for a project the user already
 * read the task as not being in. The exit's gate is now the visible half of
 * the same answer: the destination list must contain the `projectId` the task
 * carries.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ProjectRecord } from '@maka/core/project';
import { sessionMoveTargets } from '../../renderer/features/session-navigation/model/session-navigation-move-targets.js';
import type {
  SessionNavigationProjectScope,
  SessionNavigationSession,
} from '../../renderer/features/session-navigation/ports.js';

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
  it('a session in a project is offered its sibling projects and the exit', () => {
    const targets = sessionMoveTargets(
      session('s1', { projectId: 'pA' }),
      [scope('local', 'keyA', project('pA')), scope('local', 'keyB', project('pB'))],
    );
    assert.deepEqual(
      targets.map((target) => target.projectId),
      ['pA', 'pB', null],
      'the exit rides along while the project the task lives in is real',
    );
  });

  it('a session with no project is offered only projects', () => {
    const targets = sessionMoveTargets(
      session('s1'),
      [scope('local', 'keyA', project('pA')), scope('local', 'keyB', project('pB'))],
    );
    assert.deepEqual(
      targets.map((target) => target.projectId),
      ['pA', 'pB'],
      'the exit has nothing to leave',
    );
  });

  it('a session whose projectId no longer names a real project is offered the projects but not the exit', () => {
    // Regression coverage. pA used to be where s1 lived; it vanished upstream
    // (deleted, archived, relocated). The scopes the rail knows are pB and pC.
    // From the user's side s1 reads as project-less — the menu must not offer
    // only a way out of a project that is no longer there.
    const targets = sessionMoveTargets(
      session('s1', { projectId: 'pA' }),
      [scope('local', 'keyB', project('pB')), scope('local', 'keyC', project('pC'))],
    );
    assert.deepEqual(
      targets.map((target) => target.projectId),
      ['pB', 'pC'],
      'no exit when the task is not observably in any project the rail can name',
    );
  });

  it('a session whose project is archived counts as having no visible project', () => {
    const targets = sessionMoveTargets(
      session('s1', { projectId: 'pA' }),
      [
        scope('local', 'keyA', project('pA', { archivedAt: 1 })),
        scope('local', 'keyB', project('pB')),
      ],
    );
    assert.deepEqual(
      targets.map((target) => target.projectId),
      ['pB'],
      'an archived home is not a place the task can be said to live',
    );
  });

  it('a session may not be moved across hosts', () => {
    const targets = sessionMoveTargets(
      session('s1', { runtimeHostId: 'local' }),
      [scope('remote', 'keyR', project('pR')), scope('local', 'keyL', project('pL'))],
    );
    assert.deepEqual(
      targets.map((target) => target.projectId),
      ['pL'],
      'a Host only re-files its own tasks',
    );
  });

  it('an unavailable project is not a destination and not a home', () => {
    const targets = sessionMoveTargets(
      session('s1', { projectId: 'pA' }),
      [
        scope('local', 'keyA', project('pA', { available: false })),
        scope('local', 'keyB', project('pB')),
      ],
    );
    assert.deepEqual(
      targets.map((target) => target.projectId),
      ['pB'],
    );
  });
});
