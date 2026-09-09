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
import { getWorkBoardErrorCopy } from '../../renderer/locales/work-board-error-copy.js';
import { workBoardActionErrorText } from '../../renderer/work-board-panel.js';
import { ExpectedOperationError, reportUnexpectedError } from '../../renderer/application/contracts/operation-diagnostics.js';
import { getSessionCollaborationCopy } from '../../renderer/locales/session-collaboration-copy.js';
import { sessionCollaborationImportErrorMessage } from '../../renderer/features/session-collaboration/testing.js';
import {
  commandPaletteActionErrorMessage,
  commandPaletteConnectionTestFailureMessage,
  messageReadErrorMessage,
  messageRefreshErrorMessage,
  openPathActionErrorMessage,
} from '../../renderer/app-shell-copy.js';
import { getShellCopy, localizedShellErrorMessage } from '../../renderer/locales/shell-copy.js';
import { getPlanModeCopy, planControlFailureCopy } from '../../renderer/locales/plan-mode-copy.js';

test('routes Work Board codes through the shared presenter per locale', (context) => {
  context.mock.method(console, 'error', () => undefined);
  for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
    const errorCopy = getWorkBoardErrorCopy(locale);
    assert.equal(
      workBoardActionErrorText(
        new ExpectedOperationError('not_found'),
        locale,
        'action-failed-fallback',
      ),
      errorCopy.not_found,
    );
  }
  // An unexpected failure keeps the caller fallback (and logs redacted
  // diagnostics) instead of rendering the raw error.
  assert.equal(
    workBoardActionErrorText(new Error('raw internal detail'), 'zh-CN', '操作失败兜底'),
    '操作失败兜底',
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

test('the ingest token only matches at the message tail', (context) => {
  context.mock.method(console, 'error', () => undefined);
  const bare = 'attachment_ingest:count_limit';
  const wrapped = "Error invoking remote method 'sessions:send': Error: attachment_ingest:count_limit";
  assert.equal(localizedShellErrorMessage(new Error(bare), 'fallback', 'zh-CN'), '一次最多添加 8 个附件。');
  assert.equal(localizedShellErrorMessage(new Error(wrapped), 'fallback', 'en'), 'At most 8 attachments per message.');
  // Unrelated messages that merely contain the substring keep the fallback
  // and take the unexpected-error diagnostics path.
  const sneaky = 'Unable to open /tmp/attachment_ingest:count_limit/report.txt';
  assert.equal(localizedShellErrorMessage(new Error(sneaky), 'fallback', 'zh-CN'), 'fallback');
  assert.equal(localizedShellErrorMessage('path attachment_ingest:count_limit extra', 'fallback', 'en'), 'fallback');
});

test('a classified shell failure renders its category without an unexpected diagnostic', (context) => {
  const errors = context.mock.method(console, 'error', () => undefined);
  assert.equal(localizedShellErrorMessage(new Error('request timeout'), 'fallback', 'zh-CN'), '请求超时');
  assert.equal(errors.mock.callCount(), 0);
  assert.equal(localizedShellErrorMessage(new Error('boom'), 'fallback', 'zh-CN'), 'fallback');
  assert.equal(errors.mock.callCount(), 1);
});

test('maps plan control envelopes per locale at the panel', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
    const copy = getPlanModeCopy(locale);
    for (const code of ['session_busy', 'operation_conflict', 'not_found', 'persistence_failed', 'unauthorized'] as const) {
      // The wire shape the panel actually receives: the main process returns
      // the structured envelope; Electron would have stripped a thrown
      // typed error's custom fields, which is why the envelope exists.
      const failure = {
        ok: false,
        error: { code, message: 'provider detail' },
      } as const;
      assert.equal(
        planControlFailureCopy(failure.error, copy),
        copy.controlFailure[code],
        `${locale}: ${code}`,
      );
    }
    const unknownCode = { ok: false, error: { code: 'future_code', message: '' } } as const;
    assert.equal(
      planControlFailureCopy(unknownCode.error, copy),
      copy.operationFailed,
    );
  }
});


test('unknown and inherited reason tokens retain the caller fallback', (context) => {
  context.mock.method(console, 'error', () => undefined);
  for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
    for (const code of ['future_code', 'constructor']) {
      const token = `attachment_ingest:${code}`;
      for (const error of [token, new Error(token)]) {
        assert.equal(localizedShellErrorMessage(error, 'fallback', locale), 'fallback');
      }
    }
  }
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

test('shell errors keep the generalized classifier over raw text', (context) => {
  context.mock.method(console, 'error', () => undefined);
  const raw = new Error('timeout 401 网络失败 MAKA_SESSION_READ_MESSAGES_ERROR: 后端中文');
  assert.equal(messageReadErrorMessage(raw, 'en'), 'Request timed out');
  assert.equal(messageReadErrorMessage(raw, 'zh-CN'), '请求超时');
  assert.equal(
    commandPaletteActionErrorMessage(raw, 'English fallback', 'en'),
    'Request timed out',
  );
  assert.equal(commandPaletteActionErrorMessage(raw, '中文兜底', 'zh-CN'), '请求超时');
  assert.equal(
    localizedShellErrorMessage(raw, 'English fallback', 'en'),
    'Request timed out',
  );
  assert.equal(
    localizedShellErrorMessage(raw, '中文兜底', 'zh-CN'),
    '请求超时',
  );
  const unclassifiable = new Error('no category here');
  assert.equal(localizedShellErrorMessage(unclassifiable, 'English fallback', 'en'), 'English fallback');
  assert.equal(commandPaletteActionErrorMessage(unclassifiable, 'English fallback', 'en'), 'English fallback');
  assert.equal(
    messageReadErrorMessage(unclassifiable, 'zh-CN'),
    '任务内容暂时无法读取，请稍后重试。',
  );
});

test('every shell error-copy entry classifies, and keeps its contextual fallback', (context) => {
  const errors = context.mock.method(console, 'error', () => undefined);
  const timeout = new Error('request timeout');
  const opaque = new Error('no category here');
  const copy = getShellCopy('zh-CN');

  assert.equal(messageRefreshErrorMessage(timeout, 'zh-CN'), '请求超时');
  assert.equal(messageRefreshErrorMessage(opaque, 'zh-CN'), copy.errors.messageRefresh);

  assert.equal(openPathActionErrorMessage(timeout, 'skills', 'zh-CN'), '请求超时');
  assert.equal(
    openPathActionErrorMessage(opaque, 'skills', 'zh-CN'),
    copy.errors.openPath(copy.paths.skills),
  );

  // The connection test derives its own category from the status code, so an
  // unrecognized message is not a defect: contextual copy, and no diagnostic.
  const logged = errors.mock.callCount();
  assert.equal(
    commandPaletteConnectionTestFailureMessage(
      { ok: false, statusCode: 429, errorMessage: 'quota exceeded for organization' },
      'zh-CN',
    ),
    copy.commandActions.connectionFailures.rateLimit,
  );
  assert.equal(errors.mock.callCount(), logged, 'a classified connection failure logs no diagnostic');
});

test('one failure yields one diagnostic however many layers format it', (context) => {
  const errors = context.mock.method(console, 'error', () => undefined);
  const cause = new Error('an opaque backend fault');
  localizedShellErrorMessage(cause, 'inner fallback', 'en');
  localizedShellErrorMessage(cause, 'outer fallback', 'zh-CN');
  assert.equal(errors.mock.callCount(), 1);
});

test('a classified failure never reaches the diagnostics channel', (context) => {
  const errors = context.mock.method(console, 'error', () => undefined);
  reportUnexpectedError('remote-directory:list', new Error('request timeout'));
  assert.equal(errors.mock.callCount(), 0);
  reportUnexpectedError('remote-directory:list', new Error('an opaque backend fault'));
  assert.equal(errors.mock.callCount(), 1);
});
