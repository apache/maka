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

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { formatAbsoluteTimestamp } from '@maka/core/relative-time';
import type {
  StorageRetentionQueryInput,
  StorageRetentionQueryResult,
  StorageRetentionSetInput,
} from '@maka/runtime-host/protocol';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import {
  ArchiveRetentionSection,
  StorageUsageServicesProvider,
  type StorageUsageServices,
} from '../../renderer/features/storage-usage/index.js';
import {
  applyArchiveRetentionChange,
  archiveRetentionConfirm,
  getArchiveRetentionCopy,
} from '../../renderer/features/storage-usage/testing.js';
import { RuntimeHostSettingsTarget } from '../../renderer/settings/runtime-host-settings-target.js';

const HOST = { profileId: 'profile-1', hostId: 'host-1' };
const DAY = 24 * 60 * 60 * 1000;
const copy = getArchiveRetentionCopy('en');

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  getComputedStyle: globalThis.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
});

function services(retention: StorageRetentionQueryResult) {
  const reads: StorageRetentionQueryInput[] = [];
  const writes: StorageRetentionSetInput[] = [];
  const value: StorageUsageServices = {
    loadUsage: async () => assert.fail('usage is not read here'),
    loadSessionUsage: async () => ({}),
    loadRetention: async (host, input) => {
      assert.deepEqual(host, HOST);
      reads.push(input);
      return input.previewDays === undefined
        ? retention
        : { ...retention, preview: { count: 4, eligibleAt: 10 * DAY } };
    },
    setRetention: async (host, input) => {
      assert.deepEqual(host, HOST);
      writes.push(input);
      return {
        kind: 'committed',
        setting: {
          revision: input.expectedRevision + 1,
          enabled: input.enabled,
          days: input.days,
          ...(input.enabled ? { enabledAt: 1 } : {}),
        },
      };
    },
  };
  return { value, reads, writes };
}

test('a change that starts the clock is confirmed with the Host preview first', async () => {
  const off = { revision: 2, enabled: false, days: 30 } as const;
  const fake = services(off);
  const asked: Array<{ count: number; eligibleAt?: number; days: number }> = [];
  const answer = { value: false };
  const change = (current: typeof off | StorageRetentionQueryResult, enabled: boolean, days: 30 | 60 | 90) =>
    applyArchiveRetentionChange({
      services: fake.value,
      host: HOST,
      current,
      next: { enabled, days },
      confirm: async (preview, applied) => {
        asked.push({ ...preview, days: applied.days });
        return answer.value;
      },
    });

  // Declined: the preview was asked for with the new days, and nothing changed.
  assert.deepEqual(await change(off, true, 60), { kind: 'cancelled' });
  assert.deepEqual(fake.reads, [{ previewDays: 60 }]);
  assert.deepEqual(asked, [{ count: 4, eligibleAt: 10 * DAY, days: 60 }]);
  assert.deepEqual(fake.writes, []);

  answer.value = true;
  const enabled = await change(off, true, 60);
  assert.equal(enabled.kind, 'committed');
  assert.deepEqual(fake.writes, [{ expectedRevision: 2, enabled: true, days: 60 }]);

  // Turning it off deletes nothing, so it is neither previewed nor confirmed.
  const on = { revision: 3, enabled: true, days: 60, enabledAt: 1 } as const;
  assert.equal((await change(on, false, 60)).kind, 'committed');
  assert.equal(asked.length, 2);
  assert.deepEqual(fake.writes.at(-1), { expectedRevision: 3, enabled: false, days: 60 });

  // The confirm states the preview's count and date, and what is kept.
  const confirm = archiveRetentionConfirm({
    copy,
    locale: 'en',
    current: off,
    change: { enabled: true, days: 60 },
    preview: { count: 4, eligibleAt: 10 * DAY },
  });
  assert.equal(confirm.title, copy.confirmEnableTitle);
  assert.match(confirm.description ?? '', /4 tasks are covered now/);
  assert.ok(confirm.description?.includes(formatAbsoluteTimestamp(10 * DAY, 'en')));
  assert.match(confirm.description ?? '', /Pinned tasks are kept\. Deleted tasks cannot be restored\./);
  assert.equal(
    archiveRetentionConfirm({
      copy,
      locale: 'en',
      current: on,
      change: { enabled: true, days: 30 },
      preview: { count: 0 },
    }).title,
    copy.confirmChangeTitle,
  );
});

test('a stale revision reports a conflict instead of committing', async () => {
  const result = await applyArchiveRetentionChange({
    services: {
      loadRetention: async () => assert.fail('disabling needs no preview'),
      setRetention: async () => ({ kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 }),
    },
    host: HOST,
    current: { revision: 1, enabled: true, days: 30, enabledAt: 1 },
    next: { enabled: false, days: 30 },
    confirm: async () => assert.fail('disabling is not confirmed'),
  });
  assert.deepEqual(result, { kind: 'conflict' });
});

async function render(retention: StorageRetentionQueryResult) {
  const { document, window } = parseHTML('<div id="root"></div>');
  // The days selector reads the pointer and motion media queries.
  Object.assign(window, {
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  });
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    getComputedStyle: (element: Element) =>
      ({ color: (element as HTMLElement).style?.color || 'currentColor' }) as CSSStyleDeclaration,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const fake = services(retention);
  const container = document.getElementById('root') as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(StorageUsageServicesProvider, {
              services: fake.value,
              children: createElement(RuntimeHostSettingsTarget, {
                host: HOST,
                children: createElement(ArchiveRetentionSection),
              }),
            }),
          }),
        }),
      }),
    );
  });
  const text = container.textContent ?? '';
  await act(async () => root.unmount());
  return { text, fake };
}

test('the section states the rules, the preview, the last cleanup and what needs review', async () => {
  const sweptAt = 40 * DAY;
  const { text, fake } = await render({
    revision: 1,
    enabled: true,
    days: 30,
    enabledAt: 1,
    preview: { count: 5, eligibleAt: 31 * DAY },
    lastSweep: { at: sweptAt, deleted: 3, skippedBusy: 1, needsReview: 2, failed: 0 },
    lastDeletion: { at: sweptAt, count: 3, bytes: 3 * 1024 },
  });
  assert.deepEqual(fake.reads, [{}]);
  assert.match(text, /applies to every archived task/);
  assert.match(text, /The clock starts when you turn it on/);
  assert.match(text, /Pinned tasks are kept\. Deletion is permanent\./);
  assert.ok(
    text.includes(
      `Covers 5 archived tasks; the first can be deleted after ${formatAbsoluteTimestamp(31 * DAY, 'en')}.`,
    ),
  );
  assert.ok(
    text.includes(
      `Last automatic cleanup: deleted 3 tasks (about 3.0 KB) on ${formatAbsoluteTimestamp(sweptAt, 'en')}`,
    ),
  );
  assert.match(text, /2 tasks need review/);
  assert.doesNotMatch(text, /paused/);
});

test('the section shows a paused sweep and hides what it has not done', async () => {
  const { text } = await render({
    revision: 1,
    enabled: true,
    days: 30,
    enabledAt: 1,
    preview: { count: 0 },
    lastSweep: { at: 5, deleted: 0, skippedBusy: 0, needsReview: 0, failed: 0, paused: true },
  });
  assert.match(text, /Automatic cleanup is paused/);
  assert.match(text, /No archived tasks would be deleted yet\./);
  assert.doesNotMatch(text, /Last automatic cleanup/);
  assert.doesNotMatch(text, /need review/);
});

test('the legacy Archived tasks page renders the section and makes no bridge calls of its own', () => {
  const source = readFileSync(
    new URL('../../../src/renderer/settings/tasks-settings-page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /<ArchiveRetentionSection \/>/);
  assert.doesNotMatch(source, /window\.maka|\bmaka\.storage\b|useState|useEffect/);
});
