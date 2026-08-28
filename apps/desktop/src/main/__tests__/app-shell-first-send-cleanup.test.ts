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
 * #1433: the composer is now the only path that starts a conversation, and it
 * creates the session BEFORE it sends. Every way that first send can fail has
 * to take the session with it, or the sidebar collects nameless empty rows the
 * user never asked for.
 *
 * `sessions:send` fails two different ways — it returns `{ ok: false }` for a
 * blocked Skill invocation, and it REJECTS when Skill discovery or
 * project-context resolution fails (`prepareSkillInvocation`,
 * `ensureSessionCanSend`). The deleted `quick-chat.ts` carried unit tests for
 * both halves; when it went away, only the `ok: false` half kept coverage (in
 * composer-skill-invocation.spec.ts). This file covers the throw half, which
 * no E2E can reach deterministically.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LiveTurnProjection } from '@maka/ui';
import type { DesktopTranscriptRangeController } from '../../renderer/desktop-transcript-range-store.js';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';

import {
  createActionsDeps,
  createTurnState,
  installWindow,
} from './app-shell-chat-actions-fixture.js';

describe('composer first-send cleanup', () => {
  it('cancels when the composer owner changes during the readiness check', async () => {
    const readiness = deferred<boolean>();
    const activeIdRef = { current: 'session-a' as string | undefined };
    let sends = 0;
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async () => {
          sends += 1;
          return { ok: true, attachments: [], skillInvocation: { loaded: [], failed: [] } };
        },
      },
    });

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        captureComposerImportOwner: () => ({
          sessionId: activeIdRef.current,
          navSection: 'sessions',
        }),
        checkTaskSubmissionReadiness: () => readiness.promise,
        isShellSurfaceOwnerActive: (owner) => owner.sessionId === activeIdRef.current,
      });
      const sending = actions.send('hello');
      activeIdRef.current = 'session-b';
      readiness.resolve(true);

      assert.equal(await sending, false);
      assert.equal(sends, 0, 'readiness for session A must never authorize a send to session B');
    } finally {
      restoreWindow();
    }
  });

  it('passes the effective offered model when creating the first session', async () => {
    let createInput: unknown;
    const restoreWindow = installWindow({
      newTasks: {
        create: async (_target: unknown, input: unknown) => {
          createInput = input;
          return { id: 'session-1' };
        },
      },
      sessions: {
        submitMessage: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [] },
        }),
      },
    });

    try {
      const deps = {
        ...createActionsDeps(),
        newChatModel: {
          llmConnectionId: 'connection-1',
          llmConnectionSlug: 'opencode-free',
          model: 'mimo-v2.5-free',
        },
      };
      assert.equal(await createAppShellChatActions(deps).send('hello'), true);
    } finally {
      restoreWindow();
    }

    assert.equal(
      (createInput as { llmConnectionSlug?: unknown }).llmConnectionSlug,
      'opencode-free',
    );
    assert.equal((createInput as { model?: unknown }).model, 'mimo-v2.5-free');
    // Ordinary creation carries no permission mode: the Host applies its own
    // `chatDefaults`. Sending the offered default back as an explicit override
    // would make a cached snapshot the authority and could create a full-access
    // Session from a value another client already lowered.
    assert.ok(!('permissionMode' in (createInput as Record<string, unknown>)));
  });

  it('sends a composer permission choice once without writing it to the Host default', async () => {
    let createInput: unknown;
    let settingsUpdates = 0;
    const restoreWindow = installWindow({
      newTasks: {
        create: async (_target: unknown, input: unknown) => {
          createInput = input;
          return { id: 'session-1' };
        },
      },
      settings: {
        update: async () => {
          settingsUpdates += 1;
          return {};
        },
      },
      sessions: {
        submitMessage: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [] },
        }),
      },
    });

    try {
      const deps = {
        ...createActionsDeps(),
        newChatPermissionChoice: 'bypass' as const,
      };
      assert.equal(await createAppShellChatActions(deps).send('hello'), true);
    } finally {
      restoreWindow();
    }

    // An explicit choice for this draft is a per-Session override: it reaches
    // the created Session, and it does not become the Host's default for every
    // later task. Only the Settings surface writes `chatDefaults`.
    assert.equal((createInput as { permissionMode?: unknown }).permissionMode, 'bypass');
    assert.equal(settingsUpdates, 0);
  });

  it('does not re-send a consumed permission choice on the next task', async () => {
    const createInputs: unknown[] = [];
    let cleared = 0;
    const restoreWindow = installWindow({
      newTasks: {
        create: async (_target: unknown, input: unknown) => {
          createInputs.push(input);
          return { id: `session-${createInputs.length}` };
        },
      },
      sessions: {
        submitMessage: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [] },
        }),
      },
    });

    try {
      // The choice is keyed by Host/project target, not by draft, so task B on
      // the same target sees whatever task A left behind. Consuming it on a
      // successful create is what keeps a one-task elevation from becoming a
      // standing one.
      let choice: 'bypass' | undefined = 'bypass';
      const deps = () => ({
        ...createActionsDeps(),
        newChatPermissionChoice: choice,
        clearNewChatPermissionChoice: () => {
          cleared += 1;
          choice = undefined;
        },
      });
      assert.equal(await createAppShellChatActions(deps()).send('task A'), true);
      assert.equal(await createAppShellChatActions(deps()).send('task B'), true);
    } finally {
      restoreWindow();
    }

    assert.equal(cleared, 1);
    assert.equal((createInputs[0] as { permissionMode?: unknown }).permissionMode, 'bypass');
    assert.ok(!('permissionMode' in (createInputs[1] as Record<string, unknown>)));
  });

  it('creates the first session on the selected Runtime Host and project', async () => {
    let createTarget: unknown;
    let createInput: unknown;
    const restoreWindow = installWindow({
      newTasks: {
        create: async (target: unknown, input: unknown) => {
          createTarget = target;
          createInput = input;
          return { id: 'session-1' };
        },
      },
      sessions: {
        submitMessage: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [] },
        }),
      },
    });

    try {
      const deps = {
        ...createActionsDeps(),
        newTaskTarget: {
          profileId: 'office',
          hostId: 'host-office',
          projectId: 'project-docs',
        },
      };
      assert.equal(await createAppShellChatActions(deps).send('hello'), true);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(createTarget, {
      profileId: 'office',
      hostId: 'host-office',
      projectId: 'project-docs',
    });
    assert.equal((createInput as { projectId?: unknown }).projectId, undefined);
  });

  it('removes the just-created session when the first send REJECTS', async () => {
    const removed: string[] = [];
    const restoreWindow = installWindow({
      newTasks: { create: async () => ({ id: 'session-1' }) },
      sessions: {
        // What `prepareSkillInvocation` does when Skill discovery fails.
        submitMessage: async () => Promise.reject(new Error('Skill discovery failed')),
        remove: async (sessionId: string) => {
          removed.push(sessionId);
        },
      },
    });

    try {
      assert.equal(await createAppShellChatActions(createActionsDeps()).send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(removed, ['session-1']);
  });

  it('keeps the session once the first send lands', async () => {
    const removed: string[] = [];
    const restoreWindow = installWindow({
      newTasks: { create: async () => ({ id: 'session-1' }) },
      sessions: {
        submitMessage: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [] },
        }),
        // A successful send must never reach this — refreshMessagesUntilTurn
        // and the rest of the happy path run after the cleanup window closes.
        remove: async (sessionId: string) => {
          removed.push(sessionId);
        },
      },
    });

    try {
      assert.equal(await createAppShellChatActions(createActionsDeps()).send('hello'), true);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(removed, []);
  });

  it('waits for the new session observation before submitting its first message', async () => {
    const observation = deferred<void>();
    const order: string[] = [];
    const activeIdRef = { current: undefined as string | undefined };
    const restoreWindow = installWindow({
      newTasks: {
        create: async () => {
          order.push('create');
          return { id: 'session-1' };
        },
      },
      sessions: {
        submitMessage: async () => {
          order.push('submit');
          return { ok: true, attachments: [], skillInvocation: { loaded: [], failed: [] } };
        },
      },
    });

    try {
      const sending = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        activateSessionForFirstSend: async (sessionId) => {
          order.push('observe');
          activeIdRef.current = sessionId;
          await observation.promise;
          order.push('seeded');
        },
      }).send('hello');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, ['create', 'observe']);

      observation.resolve();
      assert.equal(await sending, true);
      assert.deepEqual(order, ['create', 'observe', 'seeded', 'submit']);
    } finally {
      restoreWindow();
    }
  });

  it('removes the unsent session and surfaces an observation barrier failure', async () => {
    const activeIdRef = { current: undefined as string | undefined };
    const removed: string[] = [];
    const errors: string[] = [];
    let submissions = 0;
    const restoreWindow = installWindow({
      newTasks: { create: async () => ({ id: 'session-1' }) },
      sessions: {
        submitMessage: async () => {
          submissions += 1;
          return { ok: true, attachments: [], skillInvocation: { loaded: [], failed: [] } };
        },
        remove: async (sessionId: string) => {
          removed.push(sessionId);
        },
      },
    });

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        activateSessionForFirstSend: async (sessionId) => {
          activeIdRef.current = sessionId;
          throw new Error('Timed out while preparing the new Session event stream');
        },
        setActiveId: (sessionId) => {
          activeIdRef.current = sessionId;
        },
        isNewChatSendSurfaceActive: () => activeIdRef.current === undefined,
        isShellSurfaceOwnerActive: (owner) =>
          owner.navSection === 'sessions' && owner.sessionId === activeIdRef.current,
        toastApi: {
          error: (_title, description) => {
            if (description) errors.push(description);
          },
          info: () => undefined,
        },
      });
      assert.equal(await actions.send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.equal(submissions, 0);
    assert.deepEqual(removed, ['session-1']);
    assert.equal(activeIdRef.current, undefined);
    assert.deepEqual(errors, ['The message could not be sent. Try again later.']);
  });

  it('leaves an EXISTING session alone when its send rejects', async () => {
    // Only the session this send created is disposable. A send that fails in
    // an open conversation must not delete the conversation.
    const removed: string[] = [];
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async () => Promise.reject(new Error('Skill discovery failed')),
        remove: async (sessionId: string) => {
          removed.push(sessionId);
        },
      },
    });

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'existing-session' },
      });
      assert.equal(await actions.send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(removed, []);
  });

  it('returns a sparse existing session to latest before sending', async () => {
    const latest = deferred<void>();
    const order: string[] = [];
    const activeIdRef = { current: 'existing-session' as string | undefined };
    const transcript = {
      store: {
        range: () => ({ sessionId: 'existing-session', hasNewer: true }),
        snapshot: () => ({ messages: [] }),
      },
      async loadLatest() {
        order.push('latest');
        await latest.promise;
      },
    } as unknown as DesktopTranscriptRangeController;
    const transcriptRangeRef = { current: transcript as DesktopTranscriptRangeController | undefined };
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async () => {
          order.push('send');
          return { ok: true, attachments: [], skillInvocation: { loaded: [], failed: [] } };
        },
      },
    });

    try {
      const sending = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        transcriptRangeRef,
      }).send('hello');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, ['latest']);
      latest.resolve();
      assert.equal(await sending, true);
      assert.deepEqual(order, ['latest', 'send']);
    } finally {
      restoreWindow();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * #1433 round 5: the failure feedback for a send is addressed to the surface
 * that sent, and `showModelSetupToast` is not just a toast — it ends in
 * `openSettingsSection('models')` (app-shell.tsx), so it navigates.
 *
 * This branch used to decide "am I still that surface" by comparing the
 * session id alone. `selectNavigation` never clears `activeId`
 * (nav-selection.ts), so a user who left the chat for 扩展 → 技能 while the
 * send was in flight still matched, and a readiness rejection yanked them into
 * 设置 · 模型. It now asks the shell's one owner predicate, which compares the
 * nav section too.
 */
describe('composer send failure feedback', () => {
  const readinessFailure = () => ({
    sessions: {
      submitMessage: async () =>
        Promise.reject(new Error('NO_REAL_CONNECTION:missing_api_key: no ready connection')),
      remove: async () => undefined,
    },
  });

  it('does not navigate a surface the user left mid-flight', async () => {
    const setupToasts: string[] = [];
    const restoreWindow = installWindow(readinessFailure());

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        // The user is on 技能 now. `activeId` is still 'session-a' — that is
        // the whole point: the id alone cannot answer this question.
        isShellSurfaceOwnerActive: () => false,
        isNewChatSendSurfaceActive: () => false,
        showModelSetupToast: (description: string) => setupToasts.push(description),
      });
      assert.equal(await actions.send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(setupToasts, [], 'a stale surface must not be navigated to 设置 · 模型');
  });

  it('does not invent a live turn when the send never lands', async () => {
    const turnState = createTurnState();
    const restoreWindow = installWindow(readinessFailure());

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        setLiveTurnBySession: turnState.setLiveTurnBySession,
      });
      assert.equal(await actions.send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(turnState.liveTurnBySession, {}, 'the arm must be disarmed');
  });

  it('still answers the surface that is actually waiting', async () => {
    const setupToasts: string[] = [];
    const restoreWindow = installWindow(readinessFailure());

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        isShellSurfaceOwnerActive: () => true,
        showModelSetupToast: (description: string) => setupToasts.push(description),
      });
      assert.equal(await actions.send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.equal(setupToasts.length, 1, 'the user who is still looking must get the answer');
  });
});
