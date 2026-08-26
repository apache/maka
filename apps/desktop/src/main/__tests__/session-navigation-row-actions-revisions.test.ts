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
import type { SessionSummary } from '@maka/core/session';
import { createSessionNavigationRowActions } from '../../renderer/features/session-navigation/testing.js';

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: 'Conversation',
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
    ...overrides,
  };
}

function createService(calls: string[]) {
  return {
    list: async () => [],
    setFlagged: async (id: string, value: boolean, options: { revisionFamily: true }) => {
      calls.push(`flag:${id}:${value}:${options.revisionFamily}`);
    },
    archive: async (id: string, options: { revisionFamily: true }) => {
      calls.push(`archive:${id}:${options.revisionFamily}`);
    },
    unarchive: async (id: string, options: { revisionFamily: true }) => {
      calls.push(`unarchive:${id}:${options.revisionFamily}`);
    },
    rename: async (id: string, name: string, options: { revisionFamily: true }) => {
      calls.push(`rename:${id}:${name}:${options.revisionFamily}`);
    },
    remove: async (
      id: string,
      options: { revisionFamily: true; requireArchived: boolean },
    ) => {
      calls.push(`remove:${id}:${options.revisionFamily}:${options.requireArchived}`);
      return 'removed' as const;
    },
  };
}

describe('revision-family session row actions', () => {
  it('applies conversation metadata/lifecycle to versions but not ordinary branches', async () => {
    const calls: string[] = [];
    const cleared: string[] = [];
    const selections: Array<string | undefined> = [];
    const root = summary('root');
    const version = summary('version', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
    });
    const branch = summary('branch', { parentSessionId: 'root', branchOfTurnId: 'turn-1' });
    const activeIdRef = { current: 'root' as string | undefined };
    const actions = createSessionNavigationRowActions({
      uiLocale: 'en',
      activeIdRef,
      clearActiveMessages: () => undefined,
      clearSessionRendererState: (id) => { cleared.push(id); },
      pendingSessionRowActionsRef: { current: new Set<string>() },
      refreshSessions: async () => [root, version, branch],
      service: createService(calls),
      sessionsRef: { current: [root, version, branch] },
      setActiveId: (id) => { selections.push(id); activeIdRef.current = id; },
      toastApi: {
        success: () => undefined,
        error: () => undefined,
        confirm: async () => true,
      },
    });

    await actions.flagSession('version', true);
    await actions.renameSession('branch', 'Independent branch');
    await actions.archiveSession('version');
    activeIdRef.current = 'version';
    await actions.deleteSession('root');

    assert.deepEqual(calls, [
      'flag:version:true:true',
      'rename:branch:Independent branch:true',
      'archive:version:true',
      // `root` is not archived, so the delete states no archived premise —
      // requiring one would refuse every delete from the rail.
      'remove:root:true:false',
    ]);
    assert.deepEqual(selections, [undefined, undefined]);
    assert.deepEqual(cleared, ['root', 'version', 'root', 'version']);
  });
});
