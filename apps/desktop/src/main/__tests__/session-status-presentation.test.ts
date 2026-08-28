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
  describeTurnErrorClass,
  deriveFailedTurnSeverity,
} from '../../renderer/session-status-presentation.js';

describe('failed turn presentation', () => {
  it('presents persisted provider server errors as provider failures', () => {
    assert.match(describeTurnErrorClass('server_error', 'zh'), /模型服务返回错误/);
    assert.match(describeTurnErrorClass('server_error', 'en'), /model service returned an error/i);
  });

  it('states what to do without promising a resume the UI cannot offer', () => {
    // The banner offers a button only for `app_restarted`; every other class
    // has to point at the one action that always exists — send a message.
    for (const errorClass of ['rate_limit', 'network', 'timeout', 'unknown_failure']) {
      assert.match(describeTurnErrorClass(errorClass, 'zh'), /重新发消息|再发消息|发消息/);
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
