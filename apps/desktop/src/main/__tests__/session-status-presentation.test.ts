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
import {
  describeFailedTurnExecutionState,
  describeTurnErrorClass,
  deriveFailedTurnSeverity,
} from '../../renderer/session-status-presentation.js';

const NOTHING_RAN = {
  partialOutputRetained: false,
  toolActivityCount: 0,
  erroredToolCount: 0,
};

describe('failed turn presentation', () => {
  it('presents persisted provider server errors as provider failures', () => {
    assert.match(describeTurnErrorClass('server_error', 'zh-CN'), /模型服务返回错误/);
    assert.match(describeTurnErrorClass('server_error', 'zh-TW'), /模型服務回傳錯誤/);
    assert.match(describeTurnErrorClass('server_error', 'en'), /model service returned an error/i);
  });

  it('states what to do without promising a resume the UI cannot offer', () => {
    // The banner offers a button only for `app_restarted`; every other class
    // has to point at the one action that always exists — send a message.
    for (const errorClass of ['rate_limit', 'network', 'timeout', 'unknown_failure']) {
      assert.match(describeTurnErrorClass(errorClass, 'zh-CN'), /重新发消息|再发消息|发消息/);
    }
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

  it('reports nothing when the turn left nothing to re-read', () => {
    assert.equal(describeFailedTurnExecutionState(NOTHING_RAN, 'zh-CN'), undefined);
  });

  it('prefers the most specific state the turn reached', () => {
    const all = { partialOutputRetained: true, toolActivityCount: 2, erroredToolCount: 1 };
    assert.match(describeFailedTurnExecutionState(all, 'zh-CN') ?? '', /工具执行出错/);
    assert.match(
      describeFailedTurnExecutionState({ ...all, erroredToolCount: 0 }, 'zh-CN') ?? '',
      /执行过工具/,
    );
    assert.match(
      describeFailedTurnExecutionState(
        { ...NOTHING_RAN, partialOutputRetained: true },
        'zh-CN',
      ) ?? '',
      /部分回答/,
    );
  });

});
