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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TurnViewModel } from '@maka/ui';
import { deriveAppShellTurnPresentation } from '../../renderer/app-shell-turn-view-model.js';

test('disables Copy when a completed turn ends with tool activity', () => {
  const turn: TurnViewModel = {
    turnId: 'turn-1',
    status: 'completed',
    partialOutputRetained: false,
    assistant: {
      id: 'assistant-aggregate',
      role: 'assistant',
      text: 'I am checking it.',
      ts: 2,
    },
    timeline: [
      {
        kind: 'text',
        text: 'I am checking it.',
        messageId: 'progress-1',
      },
      {
        kind: 'tools',
        items: [
          {
            toolUseId: 'read-1',
            toolName: 'Read',
            activityKind: 'read',
            status: 'completed',
            args: { path: 'README.md' },
          },
        ],
      },
    ],
    tools: [],
    notes: [],
    startedAt: 1,
  };

  const presentation = deriveAppShellTurnPresentation([turn], {
    activeId: 'session-1',
    pendingTurnActions: new Set(),
    uiLocale: 'en',
    pendingKeyOf: (sessionId, turnId, actionId) => `${sessionId}:${turnId}:${actionId}`,
  });
  const copy = presentation.footerActionsByTurn['turn-1']?.find(
    (action) => action.id === 'copy',
  );

  assert.equal(copy?.enabled, false);
  assert.equal(copy?.tooltip, 'This response has no content to copy');
});

test('disables Copy for retained partial text from a failed turn', () => {
  const turn: TurnViewModel = {
    turnId: 'turn-failed',
    status: 'failed',
    partialOutputRetained: true,
    assistant: {
      id: 'assistant-partial',
      role: 'assistant',
      text: 'Partial answer',
      ts: 2,
    },
    timeline: [
      {
        kind: 'text',
        text: 'Partial answer',
        messageId: 'partial-1',
      },
    ],
    tools: [],
    notes: [],
    startedAt: 1,
  };

  const presentation = deriveAppShellTurnPresentation([turn], {
    activeId: 'session-1',
    pendingTurnActions: new Set(),
    uiLocale: 'en',
    pendingKeyOf: (sessionId, turnId, actionId) => `${sessionId}:${turnId}:${actionId}`,
  });
  const copy = presentation.footerActionsByTurn['turn-failed']?.find(
    (action) => action.id === 'copy',
  );

  assert.equal(copy?.enabled, false);
  assert.equal(copy?.tooltip, 'This response has no content to copy');
});
