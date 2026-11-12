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
import { describe, it } from 'node:test';
import type { TurnViewModel } from '@maka/ui';
import { getDesktopConversationCopy } from '../../renderer/application/contracts/conversation-copy.js';
import { isBranchableTurnId } from '../../renderer/application/contracts/turn-footer-actions.js';
import { createChatTurnPresentationDerivation } from '../../renderer/application/contracts/turn-presentation.js';

function branchFor(turnId: string, status: TurnViewModel['status'], uiLocale: 'en' | 'zh-CN' = 'en') {
  const turns: TurnViewModel[] = [{ turnId, status, tools: [], timeline: [], notes: [], startedAt: 1 }];
  const actions = createChatTurnPresentationDerivation().derive(turns, { uiLocale, allowBranch: true })
    .footerActionsByTurn[turnId];
  const branch = actions?.find((action) => action.id === 'branch');
  assert.ok(branch, `branch action present for ${turnId}`);
  return branch;
}

describe('turn footer Branch follows the Host turn-id rule', () => {
  it('admits the id shapes the Runtime Host accepts and rejects the legacy colon form', () => {
    for (const id of ['turn-1', 'assistant-output-reply', `assistant-input-${'a'.repeat(48)}`, 'A_b-9']) {
      assert.equal(isBranchableTurnId(id), true, id);
    }
    for (const id of ['initiative:owner', 'assistant-output:batch:["b",0]', 'turn 1', '', 'a'.repeat(129)]) {
      assert.equal(isBranchableTurnId(id), false, id);
    }
  });

  it('keeps Branch enabled for a settled turn with an admissible id', () => {
    const branch = branchFor('turn-1', 'completed');
    assert.equal(branch.enabled, true);
    assert.equal(branch.tooltip, getDesktopConversationCopy('en').footer.branch);
  });

  it('disables Branch with an explanation for a settled turn whose id the Host would reject', () => {
    const branch = branchFor('initiative:owner', 'completed');
    assert.equal(branch.enabled, false);
    assert.equal(branch.tooltip, getDesktopConversationCopy('en').footer.branchUnavailable);
  });

  it('localizes the unavailable explanation', () => {
    assert.equal(
      branchFor('initiative:owner', 'completed', 'zh-CN').tooltip,
      '这是个人助手的后台回合，无法从它分支',
    );
  });

  it('keeps the running explanation ahead of the id explanation', () => {
    const branch = branchFor('initiative:owner', 'running');
    assert.equal(branch.enabled, false);
    assert.equal(branch.tooltip, getDesktopConversationCopy('en').footer.branchRunning);
  });
});
