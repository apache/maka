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
 * An exact-Turn send arms the processing indicator before it knows the Turn's
 * identity, because the model-wait window opens before any SessionEvent
 * arrives. Runtime Host names the Turn, so the client-side arm has to adopt
 * that name the moment it is answered: a Turn that ends before its first
 * text/tool event has nothing else to retire the arm, and an arm nobody can
 * retire holds "正在处理…" and Stop on forever.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { TransientUserMessageProjection } from '@maka/ui';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';

import {
  createActionsDeps,
  createTurnState,
  EMPTY_SKILL_INVOCATION,
  installWindow,
} from './app-shell-chat-actions-fixture.js';

const GRAPH_TURN = { mode: 'graph', source: 'slash_command' } as const;

describe('exact-Turn arm identity', () => {
  it('adopts the Host Turn identity the admission answered with', async () => {
    const turnState = createTurnState();
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async () => ({
          ok: true,
          disposition: 'turn_started' as const,
          turnId: 'host-turn-1',
          attachments: [],
          inlineReferences: [],
          skillInvocation: EMPTY_SKILL_INVOCATION,
        }),
      },
    });

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        setLiveTurnBySession: turnState.setLiveTurnBySession,
      });

      assert.equal(
        await actions.send('run the graph', undefined, { turnOrchestration: GRAPH_TURN }),
        true,
      );
    } finally {
      restoreWindow();
    }

    const armed = turnState.liveTurnBySession['session-a'];
    assert.equal(armed?.turnId, 'host-turn-1');
    // Still unconfirmed: the Host named the Turn, it has not yet said anything
    // about running it.
    assert.equal(armed?.unconfirmed, true);
  });

  it('releases the arm when Host admission opened no Turn under it', async () => {
    const turnState = createTurnState();
    const transient = new Map<string, TransientUserMessageProjection>();
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async () => ({ ok: false, reason: 'outcome_unknown' as const }),
      },
    });

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        setLiveTurnBySession: turnState.setLiveTurnBySession,
        addTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        updateTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        removeTransientMessage: (_sessionId, messageId) => transient.delete(messageId),
      });

      await actions.send('run the graph', undefined, { turnOrchestration: GRAPH_TURN });
    } finally {
      restoreWindow();
    }

    // The Message may well have been admitted, so its row stays for canonical
    // transcript to settle. The Turn arm is a different claim: nothing proves
    // a Turn opened under this identity, and no event will ever retire it.
    assert.equal(turnState.liveTurnBySession['session-a'], undefined);
    assert.equal(transient.size, 1);
  });
});
