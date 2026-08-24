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
import { UNRESOLVED_NEW_TASK_DRAFT_KEY } from '../../renderer/new-task-reload-intent.js';
import {
  resolveProjectSelection,
  selectAvailableProfile,
  taskEntryDraftKey,
  type TaskEntryHost,
} from '../../renderer/features/task-entry/testing.js';

function project(
  id: string,
  options: { available?: boolean; archivedAt?: number; aliases?: string[] } = {},
) {
  return {
    id,
    ...(options.aliases ? { aliases: options.aliases } : {}),
    name: id,
    locations: [{ path: `/tmp/${id}`, isWorktree: false }],
    available: options.available ?? true,
    preferredPath: `/tmp/${id}`,
    ...(options.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
  };
}

function readyHost(input: {
  id: string;
  kind?: 'local' | 'remote';
  selectedProjectId?: string | null;
  defaultProjectId?: string;
  selectNoProject?: boolean;
  projects?: ReturnType<typeof project>[];
}): Extract<TaskEntryHost, { state: 'available' }> {
  const profile = input.kind === 'remote'
    ? {
        id: input.id,
        name: input.id,
        kind: 'remote' as const,
      }
    : { id: 'local' as const, name: 'Local' as const, kind: 'local' as const };
  return {
    profile,
    hostId: `host-${input.id}`,
    readiness: 'ready',
    state: 'available',
    projects: input.projects ?? [],
    capabilities: {
      chooseClientDirectory: true,
      chooseHostDirectory: false,
      selectNoProject: input.selectNoProject ?? false,
    },
    selectedProjectId: input.selectedProjectId,
    ...(input.defaultProjectId ? { defaultProjectId: input.defaultProjectId } : {}),
    chatDefaults: { permissionMode: 'ask' },
  };
}

describe('Task Entry model', () => {
  it('keeps an available profile then falls back through default and first available', () => {
    const local = readyHost({ id: 'local' });
    const remote = readyHost({ id: 'remote', kind: 'remote' });
    const unavailable = {
      profile: {
        id: 'offline',
        name: 'Offline',
        kind: 'remote' as const,
      },
      readiness: 'unavailable' as const,
    };

    assert.equal(
      selectAvailableProfile(
        { defaultProfileId: 'local', hosts: [local, remote] },
        'remote',
      ),
      'remote',
    );
    assert.equal(
      selectAvailableProfile(
        { defaultProfileId: 'local', hosts: [remote, local] },
        'missing',
      ),
      'local',
    );
    assert.equal(
      selectAvailableProfile(
        { defaultProfileId: 'missing', hosts: [unavailable, remote] },
        undefined,
      ),
      'remote',
    );
    assert.equal(
      selectAvailableProfile(
        { defaultProfileId: 'offline', hosts: [unavailable] },
        undefined,
      ),
      'offline',
    );
  });

  it('rejects unavailable requests and preserves the Host project fallback order', () => {
    const host = readyHost({
      id: 'local',
      projects: [
        project('canonical', { aliases: ['legacy'] }),
        project('default'),
        project('missing', { available: false }),
        project('archived', { archivedAt: 1 }),
      ],
      defaultProjectId: 'default',
      selectedProjectId: 'canonical',
      selectNoProject: true,
    });

    assert.equal(resolveProjectSelection(host, 'legacy'), 'canonical');
    assert.equal(resolveProjectSelection(host, 'missing'), 'default');
    assert.equal(resolveProjectSelection(host, 'archived'), 'default');
    assert.equal(resolveProjectSelection(host, null), null);

    const withoutDefault = { ...host, defaultProjectId: undefined };
    assert.equal(resolveProjectSelection(withoutDefault, 'unknown'), 'canonical');
    const withoutSelected = { ...withoutDefault, selectedProjectId: undefined };
    assert.equal(resolveProjectSelection(withoutSelected, 'unknown'), null);
  });

  it('uses Host generation and canonical Project identity in the draft key', () => {
    assert.equal(taskEntryDraftKey(undefined), UNRESOLVED_NEW_TASK_DRAFT_KEY);
    assert.notEqual(
      taskEntryDraftKey({ profileId: 'remote', hostId: 'generation-a', projectId: 'p' }),
      taskEntryDraftKey({ profileId: 'remote', hostId: 'generation-b', projectId: 'p' }),
    );
    assert.notEqual(
      taskEntryDraftKey({ profileId: 'remote', hostId: 'generation-a', projectId: 'p' }),
      taskEntryDraftKey({ profileId: 'remote', hostId: 'generation-a', projectId: null }),
    );
  });
});
