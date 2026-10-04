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
  createStopAction,
  hasActiveTurnAtSubmit,
  interruptBeforeRootSend,
  mergeWorkspaceReferences,
  resolveExpectedTurnIdForInterrupt,
  shouldContinueRootSendAfterInterrupt,
} from '../../renderer/features/conversation/testing.js';
import { windowSubmissionServices } from './app-shell-chat-actions-fixture.js';

describe('follow-up submit routing', () => {
  it('uses the synchronous turn arm before React publishes streaming state', () => {
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurns: [{ turnId: 'turn-1' }],
        runningTurnIds: [],
      }),
      true,
    );
  });

  it('ignores a terminal projection whose only running id is the same turn', () => {
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurns: [{ turnId: 'turn-1', terminal: true }],
        runningTurnIds: ['turn-1'],
      }),
      false,
    );
  });

  it('treats a non-terminal buffer entry as active even when a terminal turn is retained', () => {
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurns: [
          { turnId: 'turn-1', terminal: true },
          { turnId: 'turn-2' },
        ],
        runningTurnIds: ['turn-1'],
      }),
      true,
    );
  });

  it('ignores multiple retained terminal turns whose running ids are already settled', () => {
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurns: [
          { turnId: 'turn-1', terminal: true },
          { turnId: 'turn-2', terminal: true },
        ],
        runningTurnIds: ['turn-1', 'turn-2'],
      }),
      false,
    );
  });

  it('treats a running turn outside the retained terminal buffer as active', () => {
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurns: [{ turnId: 'turn-1', terminal: true }],
        runningTurnIds: ['turn-1', 'turn-2'],
      }),
      true,
    );
  });

  it('refuses the root send when the active Session changes during interrupt', () => {
    assert.equal(
      shouldContinueRootSendAfterInterrupt({
        submittingSessionId: 'session-a',
        activeSessionId: 'session-b',
      }),
      false,
    );
    assert.equal(
      shouldContinueRootSendAfterInterrupt({
        submittingSessionId: 'session-a',
        activeSessionId: 'session-a',
      }),
      true,
    );
  });

  it('pins the submitting Session across an awaited interrupt before root send', async () => {
    const stopped: Array<{ sessionId: string; expectedTurnId?: string }> = [];
    const errors: Array<{ title: string; description?: string }> = [];
    const activeIdRef = { current: 'session-a' as string | undefined };
    assert.equal(
      await interruptBeforeRootSend({
        sessionId: 'session-a',
        slashCommand: undefined,
        liveTurns: [{ turnId: 'turn-1' }],
        runningTurnIds: [],
        activeSessionId: () => activeIdRef.current,
        stop: async (sessionId, expectedTurnId) => {
          stopped.push({ sessionId: sessionId ?? '', expectedTurnId });
          activeIdRef.current = 'session-b';
          return 'interrupted' as const;
        },
        uiLocale: 'en',
        toastApi: {
          error(title, description) {
            errors.push({ title, description });
          },
        },
      }),
      false,
    );
    assert.deepEqual(stopped, [{ sessionId: 'session-a', expectedTurnId: 'turn-1' }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.title ?? '', /not sent/i);
  });

  it('blocks root send when Host stop no-ops and a turn is still active', async () => {
    const target = globalThis as unknown as { window?: unknown };
    const previousWindow = target.window;
    const errors: Array<{ title: string; description?: string }> = [];
    target.window = {
      maka: {
        sessions: {
          // expectedTurnId no longer matches — Host returns undefined.
          stop: async () => undefined,
        },
      },
    };
    try {
      const stop = createStopAction({
        services: windowSubmissionServices(),
        uiLocale: 'en',
        activeIdRef: { current: 'session-a' },
        stopPending: { claim: () => true, release: () => undefined },
        removeTransientMessage: () => undefined,
        toastApi: { error() {} },
      });
      const rootSendAllowed = await interruptBeforeRootSend({
        sessionId: 'session-a',
        slashCommand: undefined,
        liveTurns: [{ turnId: 'turn-a' }],
        runningTurnIds: [],
        refreshActiveTurn: () => ({
          liveTurns: [{ turnId: 'turn-b' }],
          runningTurnIds: ['turn-b'],
        }),
        activeSessionId: () => 'session-a',
        stop,
        uiLocale: 'en',
        toastApi: {
          error(title, description) {
            errors.push({ title, description });
          },
        },
      });
      assert.equal(rootSendAllowed, false);
      assert.equal(errors.length, 1);
      assert.match(errors[0]?.title ?? '', /not sent/i);
    } finally {
      target.window = previousWindow;
    }
  });

  it('admits root send when Host stop no-ops but nothing is active anymore', async () => {
    assert.equal(
      await interruptBeforeRootSend({
        sessionId: 'session-a',
        slashCommand: undefined,
        liveTurns: [{ turnId: 'turn-a' }],
        runningTurnIds: [],
        refreshActiveTurn: () => ({
          liveTurns: [{ turnId: 'turn-a', terminal: true }],
          runningTurnIds: [],
        }),
        activeSessionId: () => 'session-a',
        stop: async () => 'not_running' as const,
      }),
      true,
    );
  });

  it('does not add a second toast when the stop itself failed', async () => {
    const errors: string[] = [];
    assert.equal(
      await interruptBeforeRootSend({
        sessionId: 'session-a',
        slashCommand: undefined,
        liveTurns: [{ turnId: 'turn-a' }],
        runningTurnIds: [],
        refreshActiveTurn: () => ({ liveTurns: [{ turnId: 'turn-a' }], runningTurnIds: ['turn-a'] }),
        activeSessionId: () => 'session-a',
        stop: async () => 'failed' as const,
        uiLocale: 'en',
        toastApi: {
          error(title) {
            errors.push(title);
          },
        },
      }),
      false,
    );
    assert.deepEqual(errors, []);
  });

  it('reports a stop still in flight instead of a blocked send', async () => {
    const errors: Array<{ title: string; description?: string }> = [];
    assert.equal(
      await interruptBeforeRootSend({
        sessionId: 'session-a',
        slashCommand: undefined,
        liveTurns: [{ turnId: 'turn-a' }],
        runningTurnIds: [],
        activeSessionId: () => 'session-a',
        stop: async () => 'busy' as const,
        uiLocale: 'en',
        toastApi: {
          error(title, description) {
            errors.push({ title, description });
          },
        },
      }),
      false,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.description ?? '', /still stopping/i);
  });

  it('pins stop to a running Host turn when the live buffer only retains terminals', async () => {
    const stopped: Array<{ sessionId: string; expectedTurnId?: string }> = [];
    assert.equal(
      await interruptBeforeRootSend({
        sessionId: 'session-a',
        slashCommand: undefined,
        liveTurns: [{ turnId: 'turn-1', terminal: true }],
        runningTurnIds: ['turn-1', 'turn-2'],
        activeSessionId: () => 'session-a',
        stop: async (sessionId, expectedTurnId) => {
          stopped.push({ sessionId: sessionId ?? '', expectedTurnId });
          return 'interrupted' as const;
        },
      }),
      true,
    );
    assert.deepEqual(stopped, [{ sessionId: 'session-a', expectedTurnId: 'turn-2' }]);
  });

  it('resolves the non-terminal live turn before Host running ids', () => {
    assert.equal(
      resolveExpectedTurnIdForInterrupt({
        liveTurns: [
          { turnId: 'turn-1', terminal: true },
          { turnId: 'turn-2' },
        ],
        runningTurnIds: ['turn-1', 'turn-2', 'turn-3'],
      }),
      'turn-2',
    );
  });

  it('restores workspace references after queued text returns to the draft', () => {
    assert.deepEqual(
      mergeWorkspaceReferences(
        'preface\n\nreview @src/app.ts',
        undefined,
        [{
          kind: 'workspace_file',
          value: '@src/app.ts',
          label: 'src/app.ts',
          start: 7,
        }],
      ),
      [{ value: '@src/app.ts', start: 16 }],
    );
  });
});
