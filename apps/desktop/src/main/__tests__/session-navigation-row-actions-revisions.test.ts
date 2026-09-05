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

function createService(
  calls: string[],
  opts: {
    disposition?: 'removed' | 'restored';
    archivedSubtaskCount?: number;
    preview?: { count?: number; throws?: boolean };
  } = {},
) {
  const { disposition = 'removed', archivedSubtaskCount = 0, preview = {} } = opts;
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
      return { disposition, archivedSubtaskCount };
    },
    previewRemoval: async (id: string) => {
      calls.push(`preview:${id}`);
      if (preview.throws) throw new Error('preview failed');
      return preview.count ?? 0;
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
      // The delete asks the Host how many subtasks it would archive before the
      // confirm, then removes.
      'preview:root',
      // `root` is not archived, so the delete states no archived premise —
      // requiring one would refuse every delete from the rail.
      'remove:root:true:false',
    ]);
    assert.deepEqual(selections, [undefined, undefined]);
    assert.deepEqual(cleared, ['root', 'version', 'root', 'version']);
  });
});

function deleteHarness(
  sessions: readonly SessionSummary[],
  disposition: 'removed' | 'restored' = 'removed',
  archivedSubtaskCount = 0,
  preview: { count?: number; throws?: boolean } = {},
) {
  const calls: string[] = [];
  const confirms: Array<{ title: string; description: string }> = [];
  const successes: Array<{ title: string; description?: string }> = [];
  const actions = createSessionNavigationRowActions({
    uiLocale: 'en',
    activeIdRef: { current: undefined },
    clearActiveMessages: () => undefined,
    clearSessionRendererState: () => undefined,
    pendingSessionRowActionsRef: { current: new Set<string>() },
    refreshSessions: async () => [...sessions],
    service: createService(calls, { disposition, archivedSubtaskCount, preview }),
    sessionsRef: { current: [...sessions] },
    setActiveId: () => undefined,
    toastApi: {
      success: (title, description) => { successes.push({ title, description }); },
      error: () => undefined,
      confirm: async (options) => { confirms.push({ title: options.title, description: options.description }); return true; },
    },
  });
  return { actions, calls, confirms, successes };
}

describe('delete confirm warns off the Host preview, toast reports the Host count', () => {
  it('warns when the Host preview reports subtasks, and the toast reports the executed count', async () => {
    const parent = summary('parent', { name: 'hi' });
    // The confirm warns off the Host preview (1); the toast reports the Host's
    // executed count (2). Neither is a renderer estimate, and the two Host reads
    // are independent — the confirm never leaks the executed number.
    const { actions, calls, confirms, successes } = deleteHarness(
      [parent],
      'removed',
      2,
      { count: 1 },
    );

    await actions.deleteSession('parent');

    // Preview runs before the remove.
    assert.deepEqual(
      calls.filter((c) => c.startsWith('preview:') || c.startsWith('remove:')),
      ['preview:parent', 'remove:parent:true:false'],
    );
    assert.equal(confirms.length, 1);
    assert.match(confirms[0].description, /kept and moved to Archived/);
    assert.doesNotMatch(confirms[0].description, /\d/);
    assert.deepEqual(successes, [{ title: 'Deleted hi', description: '2 subtasks moved to Archived' }]);
  });

  it('shows no subtask note when the Host preview reports zero', async () => {
    // e.g. a parent whose only children are graph operators: the renderer can't
    // tell from its projection, but the Host preview says 0, so no false promise.
    const { actions, confirms, successes } = deleteHarness(
      [summary('parent', { name: 'hi' })],
      'removed',
      0,
      { count: 0 },
    );

    await actions.deleteSession('parent');

    assert.equal(confirms.length, 1);
    assert.doesNotMatch(confirms[0].description, /subtask/);
    assert.deepEqual(successes, [{ title: 'Deleted hi', description: undefined }]);
  });

  it('warns with uncertainty and still deletes when the preview call fails', async () => {
    const { actions, calls, confirms, successes } = deleteHarness(
      [summary('parent', { name: 'hi' })],
      'removed',
      0,
      { throws: true },
    );

    await actions.deleteSession('parent');

    // Fail-open would hide the warning; instead the confirm hedges so it never
    // silently omits that subtasks may survive.
    assert.match(confirms[0].description, /if any.*kept and moved to Archived/);
    // The delete is not blocked by a preview failure.
    assert.ok(calls.includes('remove:parent:true:false'));
    assert.deepEqual(successes, [{ title: 'Deleted hi', description: undefined }]);
  });

  it('stays silent on the toast when a concurrent restore calls the delete off', async () => {
    const { actions, confirms, successes } = deleteHarness(
      [summary('parent', { name: 'hi' })],
      'restored',
      0,
      { count: 1 },
    );

    await actions.deleteSession('parent');

    // The confirm still warns — the person is deciding before the race resolves.
    assert.match(confirms[0].description, /kept and moved to Archived/);
    // But nothing was deleted, so nothing moved to the archive.
    assert.deepEqual(successes, [{ title: 'hi was restored, so it was kept', description: undefined }]);
  });
});
