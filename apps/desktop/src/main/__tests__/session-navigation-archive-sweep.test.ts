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
import {
  createSessionNavigationRowActions,
  type SessionNavigationSessionService,
} from '../../renderer/features/session-navigation/testing.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';

const copy = getShellCopy('en').sessionRowActions;

/** What Electron IPC does to a thrown error: keep the message, drop the class. */
function ipcError(token: string): Error {
  return new Error(`Error invoking remote method 'sessions:archive': Error: ${token}`);
}

type Harness = {
  /** Each `archive` call, in order. */
  archives: string[];
  /** Each error toast, in order. */
  errors: Array<{ title: string; description?: string }>;
  /** Each success toast, in order. */
  successes: Array<{ title: string; description?: string }>;
  /** Archive refusals per session id, popped one per call; absent archives fine. */
  refusals: Map<string, Error[]>;
};

function harness(): Harness {
  return { archives: [], errors: [], successes: [], refusals: new Map() };
}

function installService(h: Harness): SessionNavigationSessionService {
  return {
    list: async () => [],
    setFlagged: async () => undefined,
    archive: async (sessionId: string) => {
      h.archives.push(sessionId);
      const refusal = h.refusals.get(sessionId)?.shift();
      if (refusal) throw refusal;
    },
    unarchive: async () => undefined,
    rename: async () => undefined,
    remove: async () => ({ disposition: 'removed', archivedSubtaskCount: 0 }),
    previewRemoval: async () => 0,
    previewRemovals: async () => ({
      archivableSubtaskCount: 0,
      removedSubtaskCount: 0,
      worktreeCount: 0,
    }),
    moveToProject: async () => ({ ok: true }),
  };
}

function createActions(h: Harness) {
  return createSessionNavigationRowActions({
    uiLocale: 'en',
    acquireAutomaticQueryBlock: () => ({ release: () => undefined }),
    clearSessionRendererState: () => undefined,
    pendingSessionRowActionsRef: { current: new Set<string>() },
    refreshSessions: async () => [],
    service: installService(h),
    sessionsRef: { current: [] },
    toastApi: {
      success: (title: string, description?: string) => {
        h.successes.push({ title, description });
      },
      error: (title: string, description?: string) => {
        h.errors.push({ title, description });
      },
      confirm: async () => true,
    },
  });
}

describe('archiveSession refusals', () => {
  it('names the delegation action when the Host refuses for a live WorkHub delegation', async () => {
    const h = harness();
    h.refusals.set('s1', [
      ipcError('session_archive_refused: workhub_delegation'),
    ]);
    const actions = createActions(h);

    await actions.archiveSession('s1');

    assert.deepEqual(h.errors, [
      { title: copy.archiveFailedTitle, description: copy.archiveRefusedDelegation },
    ]);
  });

  it('names the subtask action when the Host refuses for a live linked child', async () => {
    const h = harness();
    h.refusals.set('s1', [ipcError('session_archive_refused: linked_child')]);
    const actions = createActions(h);

    await actions.archiveSession('s1');

    assert.deepEqual(h.errors, [
      { title: copy.archiveFailedTitle, description: copy.archiveRefusedSubtasks },
    ]);
  });

  it('keeps the generic line for a refusal it cannot explain', async () => {
    const h = harness();
    h.refusals.set('s1', [ipcError('persistence_failed: disk on fire')]);
    const actions = createActions(h);

    await actions.archiveSession('s1');

    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0]!.title, copy.archiveFailedTitle);
    assert.notEqual(h.errors[0]!.description, copy.archiveRefusedDelegation);
    assert.notEqual(h.errors[0]!.description, copy.archiveRefusedSubtasks);
  });
});

describe('archiveSelected sweep', () => {
  it('retries a parent refused ahead of its own subtask and reports success', async () => {
    const h = harness();
    // The selection lists the parent first; the Host refuses it while the
    // subtask later in the sweep is still live.
    h.refusals.set('parent', [ipcError('session_archive_refused: linked_child')]);
    const actions = createActions(h);

    await actions.archiveSelected(['parent', 'child']);

    assert.deepEqual(h.archives, ['parent', 'child', 'parent']);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.successes, [
      { title: copy.bulkArchivedTitle(2), description: copy.bulkArchiveDescription },
    ]);
  });

  it('retries a genuine refusal once and still reports it as failed', async () => {
    const h = harness();
    h.refusals.set('s1', [
      ipcError('session_archive_refused: workhub_delegation'),
      ipcError('session_archive_refused: workhub_delegation'),
    ]);
    const actions = createActions(h);

    await actions.archiveSelected(['s1']);

    assert.deepEqual(h.archives, ['s1', 's1']);
    assert.deepEqual(h.errors, [
      { title: copy.bulkArchiveFailedTitle, description: copy.archiveRefusedDelegation },
    ]);
  });
});
