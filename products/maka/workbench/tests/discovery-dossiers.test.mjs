/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
const core = new URL('../app/discoveryDossiersCore.ts', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(
      context.parentURL === core.href && specifier.startsWith('.') ? specifier + '.ts' : specifier,
      context,
    );
  },
});
const {
  buildDossierStream,
  discoveryTag,
  dossierInterrupt,
  extractFallbackChoices,
  formatChoiceDispatch,
  formatRelativeTime,
  leadFilePaths,
  notificationTarget,
  pinDossier,
  pendingActionControls,
  sortDossiers,
  splitArtifactPath,
} = await import(core.href).finally(() => hooks.deregister());

const dossier = (topicId, fields = {}) => ({
  topicId,
  title: topicId,
  signal: 'green',
  muted: false,
  revision: 1,
  lastMaterialChangeAt: 1000,
  artifactCount: 0,
  lastNotifiedRevision: 0,
  lastInterruptReason: null,
  lastInterruptAt: null,
  ...fields,
});
const a = dossier('a');
const b = dossier('b', { signal: 'yellow' });

test('relative time follows the local calendar and all three dossier locales', () => {
  const now = new Date(2026, 0, 2, 12).getTime();
  const previousEvening = new Date(2026, 0, 1, 23).getTime();
  const older = new Date(2025, 11, 29, 12);
  for (const [locale, labels] of [
    ['en', ['Just now', '14m', '2h', 'Yesterday']],
    ['zh-CN', ['刚刚', '14 分钟前', '2 小时前', '昨天']],
    ['zh-TW', ['剛剛', '14 分鐘前', '2 小時前', '昨天']],
  ]) {
    const format = (at) => formatRelativeTime(at, now, locale);
    assert.deepEqual(
      [now - 59_999, now - 14 * 60_000, now - 7_200_000, previousEvening].map(format),
      labels,
    );
    assert.equal(
      format(older.getTime()),
      older.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    );
  }
});

test('artifact basenames preserve the directory prefix on each platform', () => {
  for (const [path, dir, name] of [
    ['draft.md', '', 'draft.md'],
    ['/work/合同/draft.md', '/work/合同/', 'draft.md'],
    ['C:\\work\\draft.md', 'C:\\work\\', 'draft.md'],
  ])
    assert.deepEqual(splitArtifactPath(path), { name, dir });
});

test('confirmation follows the live action state and locks both buttons during submission', () => {
  const controls = (status, busy = false, reason) =>
    pendingActionControls({ status, receipt: { reason } }, busy);
  assert.equal(controls('awaiting_confirm').confirm, true);
  assert.equal(controls('awaiting_confirm', true).confirm, false);
  assert.equal(controls('awaiting_confirm', true).dismiss, false);
  assert.deepEqual(controls('stale'), {
    showButtons: true,
    confirm: false,
    dismiss: true,
    notice: 'Dossier source changed',
  });
  assert.equal(controls('stale', false, 'expired').notice, 'Dossier action expired');
  for (const status of ['executing', 'done', 'unknown_pending_receipt']) {
    assert.equal(controls(status).showButtons, false);
  }
  assert.equal(controls('unknown_pending_receipt').notice, 'Dossier check receipt');
});

test('dropping files retains path order and decodes escaped and non-ASCII names once', () => {
  const files = [resolve('合同 final.pdf'), resolve('50% #1.png')];
  const uris = files.map((file) => pathToFileURL(file).href);
  assert.deepEqual(leadFilePaths([uris[0], ...uris]), files);
  assert.deepEqual(leadFilePaths(uris, [files[0]]), files);
});

test('initial selection follows backend order and keeps the same topic across reorder and refresh', () => {
  const ordered = [a, b];
  const selected = pinDossier(ordered, null);
  assert.deepEqual(selected, { topicId: 'a' });
  assert.equal(pinDossier([b, { ...a, title: 'Revised', revision: 2 }], selected), selected);
  assert.deepEqual(pinDossier([b], selected), { topicId: 'b' });
  assert.equal(pinDossier([], selected), null);
});

test('a notification or lead receipt pins its requested topic ahead of list delivery', () => {
  const requested = { topicId: 'incoming', requested: true };
  assert.equal(pinDossier([], requested), requested);
  assert.equal(pinDossier([a], requested), requested);
  const arrived = pinDossier([b, dossier('incoming'), a], requested);
  assert.deepEqual(arrived, { topicId: 'incoming' });
  assert.equal(pinDossier([a, b, dossier('incoming')], arrived), arrived);
});

const interrupted = (row, revision, reason = 'Deadline moved') => ({
  ...row,
  revision,
  lastNotifiedRevision: revision,
  lastInterruptReason: reason,
  lastInterruptAt: 1000 + revision,
});
const update = (...dossiers) => ({ dossiers, notificationsEnabled: true });

test('coalesced interrupts notify once per topic, including after a later quiet revision', () => {
  const quiet = update({ ...a, revision: 8 }, b);
  const seed = dossierInterrupt(null, quiet);
  assert.deepEqual(dossierInterrupt(seed.seen, quiet).notifications, []);
  const snapshot = update({ ...interrupted(a, 8), revision: 9 }, interrupted(b, 1, 'New terms'));
  const first = dossierInterrupt(seed.seen, snapshot);
  assert.deepEqual(first.notifications, [
    { tag: 'discovery:a', title: 'a', body: 'Deadline moved' },
    { tag: 'discovery:b', title: 'b', body: 'New terms' },
  ]);
  assert.deepEqual(dossierInterrupt(first.seen, snapshot).notifications, []);
});

test('disabled or muted interrupts stay suppressed after notifications resume', () => {
  for (const snapshot of [
    { ...update(interrupted(a, 2)), notificationsEnabled: false },
    update({ ...interrupted(a, 2), muted: true }),
  ]) {
    const seed = dossierInterrupt(null, update(a));
    const hidden = dossierInterrupt(seed.seen, snapshot);
    assert.deepEqual(hidden.notifications, []);
    assert.deepEqual(dossierInterrupt(hidden.seen, update(interrupted(a, 2))).notifications, []);
    assert.equal(
      dossierInterrupt(hidden.seen, update(interrupted(a, 3))).notifications[0].tag,
      'discovery:a',
    );
  }
});

test('notification clicks preserve arbitrary topic IDs and ordinary session tags', () => {
  const topic = '收件箱:release/v2';
  assert.deepEqual(notificationTarget(discoveryTag(topic)), { kind: 'discovery', id: topic });
  assert.deepEqual(notificationTarget('conversation-1'), { kind: 'session', id: 'conversation-1' });
  for (const tag of [null, 42, {}, '', 'discovery:']) assert.equal(notificationTarget(tag), null);
});

test('recent sort keeps unresolved dossiers ahead of resolved ones in newest-first order', () => {
  const rows = [
    dossier('done-newest', { signal: 'done', lastMaterialChangeAt: 9000 }),
    dossier('old-active', { signal: 'yellow', lastMaterialChangeAt: 2000 }),
    dossier('new-active', { signal: 'red', lastMaterialChangeAt: 5000 }),
  ];
  assert.deepEqual(
    sortDossiers(rows, 'recent').map((r) => r.topicId),
    ['new-active', 'old-active', 'done-newest'],
  );
  assert.deepEqual(
    sortDossiers(rows, 'priority').map((r) => r.topicId),
    ['done-newest', 'old-active', 'new-active'],
  );
});

test('fallback choice extraction detects sequential A/B bullets and ignores normal lists', () => {
  const md = [
    '现在只需要你一句话，二选一：',
    '- A 有意放弃：那就把这个档案关掉，风险归零。',
    '- B 不是有意删的：按原 B 方案重新接回线程回传。',
  ].join('\n');
  const choices = extractFallbackChoices(md);
  assert.equal(choices.length, 2);
  assert.equal(choices[0].key, 'A');
  assert.equal(choices[0].label, '有意放弃');
  assert.equal(choices[0].resolves, true);
  assert.match(formatChoiceDispatch(choices[0]), /UpdatePreferences/);
  assert.equal(choices[1].key, 'B');
  assert.equal(choices[1].resolves, false);
  assert.equal(formatChoiceDispatch(choices[1]), choices[1].instruction);
  assert.deepEqual(extractFallbackChoices('- first item\n- second item'), []);
});

test('buildDossierStream interleaves turns between revisions chronologically and marks history', () => {
  const detail = {
    ...dossier('key-rot', { signal: 'yellow', revision: 2, lastMaterialChangeAt: 5000 }),
    summaryMd: 'v2 summary',
    artifacts: [],
    linkedTaskIds: [],
    watches: [],
    pendingActions: [],
    revisions: [
      {
        revision: 1,
        at: 1000,
        title: 'v1',
        signal: 'yellow',
        summaryMd: 'v1 summary',
        artifacts: [],
        choices: [],
      },
      {
        revision: 2,
        at: 5000,
        title: 'v2',
        signal: 'yellow',
        summaryMd: 'v2 summary',
        artifacts: [],
        choices: [],
      },
    ],
  };
  const turns = [
    { id: 't1', role: 'user', text: 'How to fix?', at: 2000 },
    { id: 't2', role: 'assistant', text: 'Use v1 script', at: 2100 },
    { id: 't3', role: 'user', text: 'Run v2', at: 6000 },
  ];
  const stream = buildDossierStream(detail, turns);
  assert.equal(stream.hasHistory, true);
  assert.equal(stream.latestRevisionIndex, 3);
  assert.deepEqual(
    stream.entries.map((e) => [e.key, e.isHistorical]),
    [
      ['rev:1', true],
      ['turn:t1', true],
      ['turn:t2', true],
      ['rev:2', false],
      ['turn:t3', false],
    ],
  );
});
