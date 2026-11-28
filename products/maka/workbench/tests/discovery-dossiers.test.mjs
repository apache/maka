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
import { readFileSync } from 'node:fs';
import { formatMessage } from '../../../../packages/plugin-sdk/src/i18n.ts';
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
  discoveryRuns,
  dossierInterrupt,
  extractFallbackChoices,
  formatChoiceDispatch,
  formatRelativeTime,
  leadFilePaths,
  nextDossierScrollState,
  notificationTarget,
  pinDossier,
  pendingActionControls,
  sortDossiers,
  splitArtifactPath,
  splitBubbleBodyAndEvidence,
} = await import(core.href).finally(() => hooks.deregister());
const { dossierThreadActivity } = await import(new URL('../app/history.ts', import.meta.url).href);

const dossier = (topicId, fields = {}) => ({
  topicId,
  title: topicId,
  signal: 'green',
  muted: false,
  revision: 1,
  lastMaterialChangeAt: 1000,
  artifactCount: 0,
  unfollowed: false,
  lastNotifiedRevision: 0,
  lastInterruptReason: null,
  lastInterruptAt: null,
  ...fields,
});
const a = dossier('a');
const b = dossier('b', { signal: 'yellow' });

test('runs show active probes first and recent finished probes in timestamp order', () => {
  const run = (id, activity, updatedAt, fields = {}) => ({
    id,
    activity,
    updatedAt,
    discoveryWorker: true,
    ...fields,
  });
  assert.deepEqual(
    discoveryRuns([
      run('active', 'working', 3),
      run('chat', 'working', 6, { discoveryWorker: false }),
      run('archived', 'idle', 5, { archived: true }),
      run('latest', 'idle', 7),
      run('older', 'idle', 4),
    ]).map((r) => r.id),
    ['active', 'latest', 'older'],
  );
});

test('relative time follows the local calendar and all three dossier locales', () => {
  const now = new Date(2026, 0, 2, 12).getTime();
  const previousEvening = new Date(2026, 0, 1, 23).getTime();
  const older = new Date(2025, 11, 29, 12);
  for (const [locale, labels] of [
    ['en', ['Just now', '14m', '2h', 'Yesterday']],
    ['zh-CN', ['刚刚', '14 分钟前', '2 小时前', '昨天']],
    ['zh-TW', ['剛剛', '14 分鐘前', '2 小時前', '昨天']],
  ]) {
    const catalog = JSON.parse(
      readFileSync(new URL('../locales/' + locale + '.json', import.meta.url), 'utf8'),
    );
    const format = (at) =>
      formatRelativeTime(at, now, locale, (key, values) =>
        formatMessage(catalog[key], locale, values),
      );
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
  assert.match(formatChoiceDispatch(choices[0]), /UpdateDiscoveryPreferences/);
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

test('dossierThreadActivity tracks active and completed tool steps after the latest user turn', () => {
  const rows = [
    { key: 'u1', role: 'user', field: 'body', text: 'Old question' },
    {
      key: 't0',
      role: 'tool_call',
      field: 'arguments',
      text: '',
      tool: {
        toolUseId: 'old-tool',
        call: {
          name: 'Read',
          title: null,
          pending: false,
          dispatched: true,
          origin: 'provider',
          ancestorToolUseIds: [],
          position: { kind: 'live', sequence: 1, fact: 'f1', itemIndex: 0 },
        },
        result: {
          settlement: 'returned',
          isError: false,
          image: false,
          images: 0,
          position: { kind: 'live', sequence: 2, fact: 'f2', itemIndex: 0 },
        },
      },
    },
    { key: 'u2', role: 'user', field: 'body', text: 'Fix PR conflict' },
    {
      key: 't1',
      role: 'tool_call',
      field: 'arguments',
      text: '',
      tool: {
        toolUseId: 'step-1',
        call: {
          name: 'Shell',
          title: 'git status',
          pending: false,
          dispatched: true,
          origin: 'code_mode',
          ancestorToolUseIds: [],
          position: { kind: 'live', sequence: 3, fact: 'f3', itemIndex: 0 },
        },
        result: {
          settlement: 'returned',
          isError: false,
          image: false,
          images: 0,
          position: { kind: 'live', sequence: 4, fact: 'f4', itemIndex: 0 },
        },
      },
    },
    {
      key: 't2',
      role: 'tool_call',
      field: 'arguments',
      text: '',
      tool: {
        toolUseId: 'step-2',
        call: {
          name: 'ApplyPatch',
          title: 'Resolve merge markers',
          pending: true,
          dispatched: true,
          origin: 'provider',
          ancestorToolUseIds: [],
          position: { kind: 'live', sequence: 5, fact: 'f5', itemIndex: 0 },
        },
        result: null,
      },
    },
  ];
  const state = dossierThreadActivity(rows);
  assert.equal(state.active, true);
  assert.deepEqual(
    state.steps.map((s) => [s.id, s.name, s.pending, s.failed]),
    [
      ['step-1', 'Shell', false, false],
      ['step-2', 'ApplyPatch', true, false],
    ],
  );
});

test('dossier activity uses turn completion when folded work is read back from history', () => {
  const user = { role: 'user', field: 'body', text: 'Review', turnId: 'current' };
  const work = { role: 'tool_call', field: 'arguments', text: '', turnId: 'current', work: {} };
  const open = { ...work, timing: { startedAt: 1, finished: null } };
  const done = { ...work, timing: { startedAt: 1, finished: { at: 2, outcome: 'completed' } } };
  assert.equal(dossierThreadActivity([user, open]).active, true);
  for (const ended of [
    [user, work],
    [user, done],
    [
      user,
      open,
      { role: 'assistant', field: 'body', text: 'Done', finalOutput: true, turnId: 'current' },
    ],
    [{ ...user, timing: done.timing }, work],
    [
      user,
      {
        ...open,
        position: {
          kind: 'snapshot',
          path: [],
          snapshot: 's',
          sequence: 2,
          fact: 'f',
          itemIndex: 0,
        },
      },
    ],
  ]) {
    assert.equal(dossierThreadActivity(ended).active, false);
  }
});

test('splitBubbleBodyAndEvidence separates explicit evidence and long legacy dumps cleanly', () => {
  assert.deepEqual(splitBubbleBodyAndEvidence('Concise update.', '## Checks\n- Item A'), {
    body: 'Concise update.',
    evidence: '## Checks\n- Item A',
  });
  assert.deepEqual(
    splitBubbleBodyAndEvidence('Short two-sentence summary. No extra table.', null),
    {
      body: 'Short two-sentence summary. No extra table.',
      evidence: null,
    },
  );

  const legacyLong = [
    'Your workspace has three pending PR checks that need attention today before the release branch cuts.',
    'Two workflows already failed with missing signing credentials and one review thread remains unresolved after yesterday.',
    'Please review the updated status summary below before running the release checklist again.',
    'If you want me to mute the build alert until Monday, choose one of the quick options underneath.',
    '',
    '## Verification Evidence',
    '| Workflow | Status | Link |',
    '| --- | --- | --- |',
    '| ci-release | failed | run-123 |',
  ].join('\n');
  const split = splitBubbleBodyAndEvidence(legacyLong, null);
  assert.match(split.body, /pending PR checks/);
  assert.doesNotMatch(split.body, /Verification Evidence/);
  assert.match(split.evidence ?? '', /## Verification Evidence/);
  assert.match(split.evidence ?? '', /ci-release/);
  const table = '| Workflow | Status\n| --- | ---\n| ci-release | failed';
  assert.deepEqual(splitBubbleBodyAndEvidence(`${split.body}\n\n${table}`), {
    body: split.body,
    evidence: table,
  });
});

test('a five-paragraph Chinese briefing stays in the bubble with its links and caveats', () => {
  const briefing = [
    '主线：本周交付的变化集中在验收时间。采购方在[周三的会议纪要](https://example.org/minutes)中确认，首批设备仍按原计划进场，但网络验收可以提前两天。现场负责人已经签字，这一项可以据此排班。',
    '进展——原先拖慢试点的登录问题已经在两个站点复测通过。第三个站点使用不同版本的网关，目前只有厂商口径称问题已修复。值班同事尚未拿到该站点的复测结果，因此本周没有把它计入通过数量。',
    '供应方面，交货单上列出的备件已全部到仓。群里提到的追加订单仍未证实，采购记录中也没有对应的审批。按现有库存排班足以覆盖首批设备，暂时无需为追加数量预留人手。',
    '成本上的变化来自运输方式。财务给出的[修订估算](https://example.org/estimate)只涵盖首批设备，节省的费用不能直接套用到后续批次。要判断整季的影响，还要等其余站点确认是否接受同一交付窗口。',
    '下周看点：周一的联合验收将决定第三个站点能否随首批上线。如果届时仍缺网关复测记录，可以先确认另外两个站点的交付时间，并请现场负责人单独约定补测窗口。',
  ].join('\n\n');
  assert.deepEqual(splitBubbleBodyAndEvidence(briefing), { body: briefing, evidence: null });
});

test('unfollowed dossiers sort below active topics and suppress desktop interrupts', () => {
  const active = dossier('active-topic', {
    signal: 'green',
    lastMaterialChangeAt: 1000,
    lastNotifiedRevision: 0,
  });
  const unfollowed = dossier('unfollowed-topic', {
    signal: 'yellow',
    unfollowed: true,
    revision: 3,
    lastMaterialChangeAt: 9000,
    lastNotifiedRevision: 3,
    lastInterruptReason: 'action_required',
    lastInterruptAt: 9000,
  });

  assert.deepEqual(
    sortDossiers([unfollowed, active], 'recent').map((d) => d.topicId),
    ['active-topic', 'unfollowed-topic'],
  );
  const interrupt = dossierInterrupt(new Map([['unfollowed-topic', 1]]), {
    dossiers: [unfollowed],
    notificationsEnabled: true,
  });
  assert.deepEqual(interrupt.notifications, []);
});

test('nextDossierScrollState keeps initial open pinned to bottom across async expansion and respects manual scroll up', () => {
  const initial = {
    stickToBottom: true,
    userInteracted: false,
    lastScrollY: 0,
    lastContentHeight: 60,
  };
  const grown = nextDossierScrollState(initial, {
    offsetY: 0,
    contentHeight: 2400,
    viewportHeight: 600,
    inProgrammaticWindow: false,
  });
  assert.equal(grown.action, 'pin');
  assert.equal(grown.stickToBottom, true);
  assert.equal(grown.userInteracted, false);
  assert.equal(grown.awayFromLatest, false);

  // Even during the programmatic scroll window, asynchronous Markdown growth keeps re-pinning.
  const asyncGrown = nextDossierScrollState(
    { ...grown, lastScrollY: 1800 },
    {
      offsetY: 1800,
      contentHeight: 2800,
      viewportHeight: 600,
      inProgrammaticWindow: true,
    },
  );
  assert.equal(asyncGrown.action, 'pin');
  assert.equal(asyncGrown.stickToBottom, true);
  assert.equal(asyncGrown.userInteracted, false);

  // Real user upward scroll disengages sticking and surfaces the "back to latest" pill.
  const readingHistory = nextDossierScrollState(
    { ...asyncGrown, lastScrollY: 2200 },
    {
      offsetY: 400,
      contentHeight: 2800,
      viewportHeight: 600,
      inProgrammaticWindow: false,
    },
  );
  assert.equal(readingHistory.action, 'none');
  assert.equal(readingHistory.stickToBottom, false);
  assert.equal(readingHistory.userInteracted, true);
  assert.equal(readingHistory.awayFromLatest, true);

  // Expanding an evidence drawer while reading old history does not jump back to the bottom.
  const expandedEvidence = nextDossierScrollState(readingHistory, {
    offsetY: 400,
    contentHeight: 3300,
    viewportHeight: 600,
    inProgrammaticWindow: false,
  });
  assert.equal(expandedEvidence.action, 'none');
  assert.equal(expandedEvidence.stickToBottom, false);
  assert.equal(expandedEvidence.awayFromLatest, null);

  // Scrolling back within 48px of bottom re-engages sticky bottom tracking.
  const returned = nextDossierScrollState(expandedEvidence, {
    offsetY: 2680,
    contentHeight: 3300,
    viewportHeight: 600,
    inProgrammaticWindow: false,
  });
  assert.equal(returned.stickToBottom, true);
  assert.equal(returned.awayFromLatest, false);
});
