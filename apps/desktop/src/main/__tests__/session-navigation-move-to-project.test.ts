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

type Harness = {
  /** Each `moveToProject` call, in order. */
  moves: Array<{ sessionId: string; projectId: string | null }>;
  /** Each error toast, in order. */
  errors: Array<{ title: string; description?: string }>;
  /** How many times the rail's catalog was read back. */
  refreshes: number;
};

function harness(): Harness {
  return { moves: [], errors: [], refreshes: 0 };
}

function installService(
  h: Harness,
  outcome: { ok: true } | { ok: false; code: 'session_busy' } = { ok: true },
): SessionNavigationSessionService {
  return {
    list: async () => [],
    setFlagged: async () => undefined,
    archive: async () => undefined,
    unarchive: async () => undefined,
    rename: async () => undefined,
    remove: async () => ({ disposition: 'removed', archivedSubtaskCount: 0 }),
    previewRemoval: async () => 0,
    moveToProject: async (sessionId: string, projectId: string | null) => {
      h.moves.push({ sessionId, projectId });
      return outcome;
    },
  };
}

function createActions(h: Harness, service: SessionNavigationSessionService) {
  return createSessionNavigationRowActions({
    uiLocale: 'en',
    clearSessionRendererState: () => undefined,
    pendingSessionRowActionsRef: { current: new Set<string>() },
    refreshSessions: async () => {
      h.refreshes += 1;
      return [];
    },
    service,
    sessionsRef: { current: [] },
    toastApi: {
      success: () => undefined,
      error: (title: string, description?: string) => {
        h.errors.push({ title, description });
      },
      confirm: async () => true,
    },
  });
}

describe('moveSessionToProject', () => {
  it('re-files the task and reads the catalog back, staying silent on success', async () => {
    const h = harness();
    const actions = createActions(h, installService(h));

    await actions.moveSessionToProject('s1', 'p1');

    assert.deepEqual(h.moves, [{ sessionId: 's1', projectId: 'p1' }]);
    assert.equal(h.refreshes, 1);
    assert.deepEqual(h.errors, []);
  });

  it('passes `null` through to detach the task from every project', async () => {
    const h = harness();
    const actions = createActions(h, installService(h));

    await actions.moveSessionToProject('s1', null);

    assert.deepEqual(h.moves, [{ sessionId: 's1', projectId: null }]);
    assert.equal(h.refreshes, 1);
  });

  it('names the Host reason for a refused move and does not read the catalog back', async () => {
    const h = harness();
    const actions = createActions(h, installService(h, { ok: false, code: 'session_busy' }));

    await actions.moveSessionToProject('s1', 'p1');

    assert.deepEqual(h.errors, [
      { title: copy.moveFailedTitle, description: copy.moveFailures.session_busy },
    ]);
    assert.equal(h.refreshes, 0);
  });
});
