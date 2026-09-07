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
import { deriveAppShellTurnPresentation } from '../../renderer/app-shell-turn-view-model.js';
import {
  describeFailedTurnExecutionState,
  describeTurnErrorClass,
  deriveFailedTurnSeverity,
} from '../../renderer/session-status-presentation.js';

const NOTHING_RAN = {
  toolActivityCount: 0,
  erroredToolCount: 0,
};

describe('failed turn presentation', () => {
  it('presents persisted provider server errors as provider failures', () => {
    assert.match(describeTurnErrorClass('server_error', 'zh-CN'), /模型服务返回错误/);
    assert.match(describeTurnErrorClass('server_error', 'zh-TW'), /模型服務回傳錯誤/);
    assert.match(describeTurnErrorClass('server_error', 'en'), /model service returned an error/i);
    // Before #3758 the adapter persisted these codes with an unknown kind.
    assert.equal(describeTurnErrorClass('ECONNRESET', 'en'), describeTurnErrorClass('network', 'en'));
  });

  it('keeps the failure summary from contradicting recorded retry refusals', () => {
    for (const errorClass of ['rate_limit', 'network', 'timeout']) {
      for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
        assert.doesNotMatch(describeTurnErrorClass(errorClass, locale), /重试|重試|retry|send a message/i);
      }
    }
    assert.doesNotMatch(describeTurnErrorClass('unknown_failure', 'zh-CN'), /重试|重发/);
    assert.match(describeTurnErrorClass('stream_truncated', 'zh-CN'), /中途断开/);
    assert.match(describeFailedTurnExecutionState({ ...NOTHING_RAN, retry: { decision: 'declined', because: 'side_effects' } }, 'zh-CN')!, /未自动重试/);
  });

  it('grades continuable outcomes below outcomes the user must act on', () => {
    assert.equal(deriveFailedTurnSeverity('app_restarted'), 'warning');
    assert.equal(deriveFailedTurnSeverity('tool_step_cap_reached'), 'warning');
    assert.equal(deriveFailedTurnSeverity('permission_required'), 'warning');
    assert.equal(deriveFailedTurnSeverity('auth'), 'error');
    assert.equal(deriveFailedTurnSeverity('context_overflow'), 'error');
    assert.equal(deriveFailedTurnSeverity(undefined), 'error');
  });
});

describe('failed turn execution state', () => {
  it('warns that a completed tool may already have taken effect', () => {
    // A blind resend after a side-effecting tool can repeat that effect, so
    // this has to survive alongside a transport failure like `timeout`.
    const zh = describeFailedTurnExecutionState({ ...NOTHING_RAN, toolActivityCount: 1 }, 'zh-CN');
    assert.match(zh ?? '', /执行过工具|实际改动/);
    const en = describeFailedTurnExecutionState({ ...NOTHING_RAN, toolActivityCount: 1 }, 'en');
    assert.match(en ?? '', /tools already ran/i);
  });

  it('does not let execution state displace the error class', () => {
    // The retired recovery derivation ranked these against each other and let
    // the tool branch win, so `auth` plus an errored tool advised "inspect the
    // tool result" and dropped the sign-in step. They are separate slots now.
    const state = { ...NOTHING_RAN, toolActivityCount: 1, erroredToolCount: 1 };
    assert.match(describeTurnErrorClass('auth', 'zh-CN'), /重新连接或登录/);
    assert.match(describeFailedTurnExecutionState(state, 'zh-CN') ?? '', /工具执行出错/);
    assert.match(describeTurnErrorClass('context_overflow', 'zh-CN'), /减少附件|开启新任务/);
    assert.match(describeFailedTurnExecutionState(state, 'zh-TW') ?? '', /工具執行出錯/);
  });

  it('offers no execution guidance for a Turn that ran nothing', () => {
    assert.equal(describeFailedTurnExecutionState(NOTHING_RAN, 'zh-CN'), undefined);
  });

  it('prefers the most specific state the turn reached', () => {
    const all = { toolActivityCount: 2, erroredToolCount: 1 };
    assert.match(describeFailedTurnExecutionState(all, 'zh-CN') ?? '', /工具执行出错/);
    assert.match(
      describeFailedTurnExecutionState({ ...all, erroredToolCount: 0 }, 'zh-CN') ?? '',
      /执行过工具/,
    );
  });

});

it('does not hide a terminal diagnostic behind a sandbox tool failure or promote a tool failure to a failed turn', () => {
  const turn: TurnViewModel = { turnId: 't1', status: 'failed', errorClass: 'unknown', failureMessage: 'Provider request failed after the tool result', tools: [{ toolUseId: 'tool-1', toolName: 'Bash', status: 'errored', args: {}, result: { kind: 'text', text: 'Operation not permitted', sandboxDenial: { likely: true } } }], timeline: [], notes: [], startedAt: 1 };
  const context = { activeId: 'session-1', pendingTurnActions: new Set<string>(), uiLocale: 'en' as const };
  assert.ok(deriveAppShellTurnPresentation([turn], context).failedReasonLabels.t1);
  assert.equal(deriveAppShellTurnPresentation([{ ...turn, status: 'completed' }], context).failedReasonLabels.t1, undefined);
});
