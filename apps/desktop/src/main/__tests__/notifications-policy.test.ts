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

import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHostPrivacyAuthority,
  isRunNotificationKind,
  resolveNotificationContent,
  resolveNotificationIncognito,
  runNotificationCopy,
  shouldRaiseRunNotification,
} from '../notifications-policy.js';
import type { RuntimeHostDesktopTargetState } from '../runtime-host-desktop-manager.js';

it('gates native notifications through every required condition', () => {
  const base = { enabled: true, supported: true, windowFocused: false, incognito: false, e2e: false };
  const cases = [
    [base, true],
    [{ ...base, enabled: false }, false],
    [{ ...base, supported: false }, false],
    [{ ...base, windowFocused: true }, false],
    [{ ...base, incognito: true }, false],
    [{ ...base, e2e: true }, false],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(shouldRaiseRunNotification(input), expected);
  }
});

it('recognizes terminal kinds and keeps distinct localized fallback copy', () => {
  for (const value of ['completed', 'errored']) assert.equal(isRunNotificationKind(value), true);
  for (const value of ['complete', 'error', 'aborted', '', undefined, null, 1, {}]) {
    assert.equal(isRunNotificationKind(value), false);
  }

  const completed = runNotificationCopy('completed', 'zh-CN');
  const errored = runNotificationCopy('errored', 'zh-CN');
  assert.ok(completed.title && completed.body);
  assert.ok(errored.title && errored.body);
  assert.notEqual(completed.title, errored.title);

  assert.deepEqual(runNotificationCopy('completed', 'zh-TW'), {
    title: '回答已產生',
    body: 'Maka 已完成本次回答，按一下以檢視。',
  });
});

it('sanitizes renderer content, caps it, and falls back per field', () => {
  const clean = resolveNotificationContent(
    { kind: 'completed', title: '  会话  A  ', body: 'line one\n\nline two\tindented' },
    'zh-CN',
  );
  assert.deepEqual(clean, { title: '会话 A', body: 'line one line two indented' });

  const completedFallback = runNotificationCopy('completed', 'zh-CN');
  for (const value of ['', '   ', undefined, null, 42, {}]) {
    assert.deepEqual(
      resolveNotificationContent({ kind: 'completed', title: value, body: value }, 'zh-CN'),
      completedFallback,
    );
  }

  const capped = resolveNotificationContent(
    { kind: 'completed', title: 'S', body: 'x'.repeat(500) },
    'zh-CN',
  );
  assert.equal(capped.body.length, 160);
  assert.ok(capped.body.endsWith('…'));

  const erroredFallback = runNotificationCopy('errored', 'zh-CN');
  assert.deepEqual(
    resolveNotificationContent({ kind: 'errored', title: '出错的会话', body: '' }, 'zh-CN'),
    { title: '出错的会话', body: erroredFallback.body },
  );
});

it('reads incognito from the Runtime Host authority, failing closed', async () => {
  // The authority verdict wins: the local copy never receives privacy
  // updates, so no stale local value may decide content-bearing banners.
  assert.equal(
    await resolveNotificationIncognito({ isIncognitoActive: async () => true }, 'local'),
    true,
  );
  assert.equal(
    await resolveNotificationIncognito({ isIncognitoActive: async () => false }, 'local'),
    false,
  );
  // The source host travels with the query so the gate can associate the
  // banner with its legitimate authority.
  const seen: Array<string | undefined> = [];
  await resolveNotificationIncognito(
    {
      isIncognitoActive: async (sourceHostId) => {
        seen.push(sourceHostId);
        return false;
      },
    },
    'local',
  );
  assert.deepEqual(seen, ['local']);
  // An unreachable authority suppresses rather than risking exposure of
  // the session title + reply preview outside the app.
  assert.equal(
    await resolveNotificationIncognito(
      {
        isIncognitoActive: async () => {
          throw new Error('host unreachable');
        },
      },
      'local',
    ),
    true,
  );
});

it('scopes the host authority to the notification source host', async () => {
  const queried: string[] = [];
  const ready = (hostId: string, incognitoActive: boolean) =>
    ({
      epoch: `epoch-${hostId}`,
      target: { profile: { id: hostId } },
      readiness: 'ready',
      candidate: {
        client: {
          hostId,
          queryRuntimePolicy: async () => {
            queried.push(hostId);
            return { policy: { privacy: { incognitoActive } } };
          },
        },
      },
    }) as unknown as RuntimeHostDesktopTargetState;
  const reconnecting = (hostId: string) =>
    ({
      epoch: `epoch-${hostId}`,
      target: { profile: { id: hostId } },
      readiness: 'reconnecting',
      hostId,
    }) as unknown as RuntimeHostDesktopTargetState;
  const guest = (hostId: string) =>
    ({
      epoch: `epoch-${hostId}`,
      target: { profile: { id: hostId } },
      readiness: 'ready',
      candidate: {
        client: {
          hostId,
          queryRuntimePolicy: async () => {
            queried.push(hostId);
            throw new Error('forbidden: runtime.policy.query');
          },
        },
      },
    }) as unknown as RuntimeHostDesktopTargetState;

  // A reconnecting source keeps its unknown verdict (suppressed) even
  // while another ready host holds no incognito: dropping it would leak.
  assert.equal(
    await resolveNotificationIncognito(
      createHostPrivacyAuthority(() => [ready('local', false), reconnecting('private')]),
      'private',
    ),
    true,
  );
  // A mounted session guest never decides a local notification: only the
  // notification's own host is queried, so the local banner is preserved.
  assert.equal(
    await resolveNotificationIncognito(
      createHostPrivacyAuthority(() => [ready('local', false), guest('shared')]),
      'local',
    ),
    false,
  );
  assert.deepEqual(queried, ['local']);
  // No matching host (or no source at all) stays unknown and suppresses.
  assert.equal(
    await resolveNotificationIncognito(
      createHostPrivacyAuthority(() => [ready('local', false)]),
      'gone',
    ),
    true,
  );
  assert.equal(
    await resolveNotificationIncognito(
      createHostPrivacyAuthority(() => [ready('local', false)]),
      undefined,
    ),
    true,
  );
});
