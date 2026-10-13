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
import { appUpdateErrorSummary, classifyAppUpdateError } from '@maka/core/app-update-error';
import { appUpdateErrorMessage } from '../../renderer/features/app-update/testing.js';
import { aboutUpdateRow } from '../../renderer/settings/about-update-status.js';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';

// Public release notes contain both misleading substrings from the incident.
const feed =
  '<feed><entry><content>initial-code authorization review; incorporate this work; HTTP 429 Too Many Requests</content></entry></feed>';
function feedError(status: string): Error & { code: string } {
  return Object.assign(
    new Error(
      `Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/apache/maka/releases/latest), please ensure a production release exists: HttpError: ${status}\n    at request (/tmp/rate-limit/authorization/401:500:1),\nXML:\n${feed}`,
    ),
    { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' },
  );
}

test('excludes attached release notes while preserving actual transport evidence', () => {
  for (const [status, expected] of [
    ['406 Not Acceptable', 'release_unavailable'],
    [
      '404 Not Found\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.',
      'release_unavailable',
    ],
    ['429 Too Many Requests', 'rate_limited'],
    ['401 Unauthorized', 'auth_failed'],
    ['403 Forbidden', 'auth_failed'],
    ['504 Gateway Timeout', 'timeout'],
    ['503 Service Unavailable', 'provider_error'],
    ['net::ERR_CONNECTION_RESET', 'network_error'],
  ] as const) {
    const error = feedError(status);
    assert.equal(classifyAppUpdateError(error), expected, status);
    const summary = appUpdateErrorSummary(error);
    assert.equal(summary.errorCode, 'ERR_UPDATER_INVALID_RELEASE_FEED');
    assert.doesNotMatch(
      summary.message,
      /<feed>|incorporate|authorization review|authentication token|at request/,
    );
    // Classification must survive IPC serialization as a plain status object.
    assert.equal(classifyAppUpdateError(summary), expected, status);
  }
});

test('distinguishes unavailable releases and missing or invalid update metadata', () => {
  assert.equal(
    classifyAppUpdateError(
      Object.assign(new Error('No published versions on GitHub'), {
        code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
      }),
    ),
    'release_unavailable',
  );
  for (const code of ['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_INVALID_UPDATE_INFO']) {
    assert.equal(
      classifyAppUpdateError(Object.assign(new Error('Update metadata missing'), { code })),
      'metadata_unavailable',
    );
  }
  assert.equal(
    classifyAppUpdateError(new Error('Cannot parse releases feed: malformed XML')),
    'metadata_unavailable',
  );
});

test('redacts credentials in diagnostic summaries', () => {
  const summary = appUpdateErrorSummary(feedError('406 token=private-secret'));
  assert.doesNotMatch(summary.message, /private-secret/);
  assert.match(summary.message, /\[redacted\]/);
});

test('uses update-specific copy in all locales, including the About row', () => {
  const error = feedError('406 Not Acceptable');
  for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
    const message = appUpdateErrorMessage(error, locale);
    assert.doesNotMatch(message, /模型|model|鉴权|驗證|Authentication/);
    const status = {
      state: 'error',
      operation: 'check',
      currentVersion: '0.2.0',
      ...appUpdateErrorSummary(error),
    } as const;
    assert.equal(
      aboutUpdateRow(status, getSettingsPreferencesCopy(locale).about, {
        errorDetail: (status) => appUpdateErrorMessage(status, locale),
      }).description,
      message,
    );
    assert.doesNotMatch(
      appUpdateErrorMessage(feedError('503 Service Unavailable'), locale),
      /模型|model/,
    );
  }
  assert.equal(
    appUpdateErrorMessage(error, 'zh-CN'),
    '当前无法获取此更新通道的版本信息，请稍后重试。',
  );
});
