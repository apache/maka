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
import test from 'node:test';
import { getDesktopConversationCopy } from '../../renderer/locales/conversation-copy.js';
import { getWorkBoardErrorCopy } from '../../renderer/locales/work-board-error-copy.js';
import { getSessionCollaborationCopy } from '../../renderer/locales/session-collaboration-copy.js';
import { ExpectedOperationError } from '../../renderer/application/contracts/operation-diagnostics.js';
import { sessionCollaborationImportErrorMessage } from '../../renderer/features/session-collaboration/testing.js';
import { messageReadErrorMessage } from '../../renderer/app-shell-copy.js';
import { localizedShellErrorMessage } from '../../renderer/locales/shell-copy.js';

test('routes Work Board codes through each locale catalog', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
    const copy = getDesktopConversationCopy(locale).workBoardPanel;
    const errorCopy = getWorkBoardErrorCopy(locale);
    const error: unknown = new ExpectedOperationError<'not_found'>('not_found');
    assert.equal(
      error instanceof ExpectedOperationError && Object.hasOwn(errorCopy, error.code)
        ? errorCopy[error.code as keyof typeof errorCopy]
        : copy.actionFailed,
      errorCopy.not_found,
    );
  }
});

test('maps blocked session-control tokens per locale at the shared entry', () => {
  const blocked = new Error('session_control_blocked:permission_turn_running');
  assert.equal(
    localizedShellErrorMessage(blocked, 'fallback', 'zh-CN'),
    '当前任务正在运行，等结束后再切换权限模式。',
  );
  assert.equal(
    localizedShellErrorMessage(blocked, 'fallback', 'en'),
    'A task is still running. Change the permission mode after it finishes.',
  );
});

test('maps attachment-ingest tokens per locale at the shared entry', () => {
  const blocked = new Error("Error invoking remote method 'attachments': Error: attachment_ingest:count_limit");
  assert.equal(localizedShellErrorMessage(blocked, 'fallback', 'zh-CN'), '一次最多添加 8 个附件。');
  assert.equal(
    localizedShellErrorMessage(blocked, 'fallback', 'en'),
    'At most 8 attachments per message.',
  );
});

test('routes structured collaboration failures through each locale catalog', () => {
  const cases = [
    [{ kind: 'error', reason: 'invalid_code' } as const, 'invalidCode'],
    [{ kind: 'error', reason: 'peer_path_unavailable' } as const, 'directPathUnavailable'],
    [{ kind: 'error', reason: 'connection_failed' } as const, 'connectionFailed'],
  ] as const;
  for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
    const copy = getSessionCollaborationCopy(locale);
    for (const [result, key] of cases) {
      assert.equal(sessionCollaborationImportErrorMessage(copy, result), copy[key]);
    }
    assert.equal(
      sessionCollaborationImportErrorMessage(copy, {
        kind: 'error',
        reason: 'mount_limit_reached',
        params: { max: 12 },
      }),
      copy.mountLimit(12),
    );
  }
});

test('uses localized fallbacks instead of classifying raw exception text', (context) => {
  context.mock.method(console, 'error', () => undefined);
  const raw = new Error('timeout 401 网络失败 MAKA_SESSION_READ_MESSAGES_ERROR: 后端中文');
  assert.equal(
    messageReadErrorMessage(raw, 'en'),
    'Task content is temporarily unavailable. Try again later.',
  );
  assert.equal(messageReadErrorMessage(raw, 'zh-CN'), '任务内容暂时无法读取，请稍后重试。');
  assert.equal(localizedShellErrorMessage(raw, 'English fallback', 'en'), 'English fallback');
  assert.equal(localizedShellErrorMessage(raw, '中文兜底', 'zh-CN'), '中文兜底');
});
