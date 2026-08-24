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
import { createAppShellSessionRowActions } from '../../renderer/app-shell-session-row-actions.js';

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

function installWindow(calls: string[]): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const previous = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    writable: true,
    value: {
      maka: {
        sessions: {
          setFlagged: async (id: string, value: boolean, options?: { revisionFamily?: boolean }) => { calls.push(`flag:${id}:${value}:${options?.revisionFamily === true}`); },
          archive: async (id: string, options?: { revisionFamily?: boolean }) => { calls.push(`archive:${id}:${options?.revisionFamily === true}`); },
          unarchive: async (id: string, options?: { revisionFamily?: boolean }) => { calls.push(`unarchive:${id}:${options?.revisionFamily === true}`); },
          rename: async (id: string, name: string, options?: { revisionFamily?: boolean }) => { calls.push(`rename:${id}:${name}:${options?.revisionFamily === true}`); },
          remove: async (id: string, options?: { revisionFamily?: boolean; requireArchived?: boolean }) => { calls.push(`remove:${id}:${options?.revisionFamily === true}:${options?.requireArchived === true}`); return 'removed' as const; },
        },
      },
    },
  });
  return () => {
    if (previous === undefined) delete target.window;
    else Object.defineProperty(target, 'window', { configurable: true, writable: true, value: previous });
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
    const restore = installWindow(calls);
    const actions = createAppShellSessionRowActions({
      uiLocale: 'en',
      activeIdRef,
      clearSessionRendererState: (id) => { cleared.push(id); },
      pendingSessionRowActionsRef: { current: new Set<string>() },
      refreshSessions: async () => [root, version, branch],
      sessionsRef: { current: [root, version, branch] },
      setActiveId: (id) => { selections.push(id); activeIdRef.current = id; },
      setMessages: () => undefined,
      toastApi: {
        success: () => undefined,
        error: () => undefined,
        confirm: async () => true,
      },
    });

    try {
      await actions.flagSession('version', true);
      await actions.renameSession('branch', 'Independent branch');
      await actions.archiveSession('version');
      activeIdRef.current = 'version';
      await actions.deleteSession('root');
    } finally {
      restore();
    }

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
