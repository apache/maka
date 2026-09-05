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
import { describe, test } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import { sessionStatusBadge } from '../tui-session-status.js';

describe('TUI Session status badge', () => {
  test('only marks running when the Runtime Host reports a live Turn', () => {
    assert.equal(sessionStatusBadge(session({ status: 'running' }), 'en'), undefined);
    assert.equal(
      sessionStatusBadge(session({ status: 'running', runningTurnIds: [] }), 'en'),
      undefined,
    );
    assert.equal(
      sessionStatusBadge(session({ status: 'running', runningTurnIds: ['turn-1'] }), 'en'),
      'running',
    );
  });

  test('distinguishes user questions from permission requests with localized copy', () => {
    assert.equal(
      sessionStatusBadge(session({ status: 'waiting_for_user' }), 'en'),
      'waiting for you',
    );
    assert.equal(
      sessionStatusBadge(
        session({ status: 'waiting_for_user', blockedReason: 'permission_required' }),
        'en',
      ),
      'needs permission',
    );
    assert.equal(sessionStatusBadge(session({ status: 'waiting_for_user' }), 'zh-CN'), '等你确认');
  });

  test('marks only actionable blocked reasons and keeps resting rows unmarked', () => {
    assert.equal(
      sessionStatusBadge(session({ status: 'blocked', blockedReason: 'NO_REAL_CONNECTION' }), 'en'),
      'needs connection',
    );
    assert.equal(
      sessionStatusBadge(session({ status: 'blocked', blockedReason: 'auth' }), 'en'),
      'needs sign-in',
    );
    assert.equal(
      sessionStatusBadge(
        session({ status: 'blocked', blockedReason: 'permission_required' }),
        'en',
      ),
      'needs permission',
    );
    for (const blockedReason of ['tool_failed', 'unknown'] as const) {
      assert.equal(
        sessionStatusBadge(session({ status: 'blocked', blockedReason }), 'en'),
        undefined,
      );
    }
    assert.equal(sessionStatusBadge(session({ status: 'active' }), 'en'), undefined);
    assert.equal(sessionStatusBadge(session({ status: 'aborted' }), 'en'), 'stopped');
    assert.equal(sessionStatusBadge(session({ status: 'aborted' }), 'zh-CN'), '已中止');
  });
});

function session(
  overrides: Partial<Pick<SessionSummary, 'status' | 'blockedReason' | 'runningTurnIds'>> = {},
): Pick<SessionSummary, 'status' | 'blockedReason' | 'runningTurnIds'> {
  return { status: 'active', ...overrides };
}
