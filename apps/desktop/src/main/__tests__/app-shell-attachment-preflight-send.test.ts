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
 * Review regression on #4457: the new-task send path runs the renderer-side
 * attachment preflight BEFORE `newTasks.create`, so the main-side token
 * validation never sees an over-limit request. The preflight must reject with
 * the same stable `attachment_ingest:<code>` tokens main rejects with, so the
 * send catch maps the real reason through the locale catalog instead of the
 * generic "try again later" fallback (retrying nine attachments can never
 * succeed) — and an expected rejection must not log an unexpected diagnostic.
 */

import { MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { PendingAttachment } from '../../renderer/composer-attachments.js';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';
import {
  createActionsDeps,
  installWindow,
} from './app-shell-chat-actions-fixture.js';

function fileAttachment(size: number, index: number): PendingAttachment {
  return {
    stagingKey: `staged-file-${index}`,
    displayName: 'report.txt',
    kind: 'other',
    size,
    source: { type: 'file', file: { size } },
  } as PendingAttachment;
}

test('a nine-attachment new-task send shows the count reason, creates no session, and logs no unexpected diagnostic', async (context) => {
  const errorLog = context.mock.method(console, 'error', () => undefined);
  const created: unknown[] = [];
  const toasts: Array<{ title: string; description?: string }> = [];
  const restoreWindow = installWindow({
    newTasks: {
      create: async () => {
        created.push(true);
        return { id: 'session-created-anyway' };
      },
    },
  });

  try {
    for (const locale of ['zh-CN', 'en'] as const) {
      toasts.length = 0;
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        uiLocale: locale,
        toastApi: {
          error: (title, description) => {
            toasts.push({ title, description });
          },
          info: () => undefined,
        },
      });
      const pending = Array.from(
        { length: MAX_ATTACHMENT_COUNT + 1 },
        (_, index) => fileAttachment(10, index),
      );
      const accepted = await actions.send('hello', pending);
      assert.equal(accepted, false, `${locale}: the send must be rejected`);
      assert.equal(created.length, 0, `${locale}: preflight runs before the session exists`);
      assert.equal(toasts.length, 1, `${locale}: exactly one rejection toast`);
      assert.equal(
        toasts[0].description,
        getShellCopy(locale).sessionSettingsActions.attachmentIngestBlocked.count_limit,
        `${locale}: the toast carries the count reason, not the generic fallback`,
      );
    }
  } finally {
    restoreWindow();
  }
  assert.equal(
    errorLog.mock.callCount(),
    0,
    'an expected preflight rejection must not land the unexpected-error diagnostic',
  );
});