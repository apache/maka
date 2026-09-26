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

// A board of cards in three columns, installed into a running Maka whose
// binary knows nothing about it: the TUI shows it through the terminal app
// contract alone.

/** @typedef {'todo' | 'doing' | 'done'} Column */
/** @typedef {{id: string, title: string, column: Column, note: string}} Card */

/** @param {import('../../../../../packages/plugin-sdk/src/host.js').HostContext} ctx */
export default async function activate(ctx) {
  const { tui } = ctx;
  const columns = /** @type {const} */ (['todo', 'doing', 'done']);
  /** @returns {Promise<{revision: number | null, cards: Card[]}>} */
  const load = async () => {
    const record = await ctx.storage.read('cards');
    const value = /** @type {{cards: Card[]} | null} */ (
      record?.data.kind === 'present' ? record.data.value : null
    );
    return { revision: record?.revision ?? null, cards: value?.cards ?? [] };
  };
  // This read-only activity source uses the public SDK store. Text updates never
  // invalidate the Board View; the same kernel transcript renders each record.
  /** @typedef {import('../../../../../packages/plugin-sdk/src/host.js').TranscriptBlock} Block */
  /** @param {string} message @param {string} text @returns {Block} */
  const note = (message, text) => ({
    key: { turn: 'board-activity', message, part: 'text' },
    revision: '1',
    kind: 'assistant',
    content: { text },
  });
  const liveKey = { turn: 'board-activity', message: 'live', part: /** @type {const} */ ('text') };
  const history = Array.from({ length: 300 }, (_, index) =>
    note(`history-${index}`, `Board history ${String(index).padStart(3, '0')} — 卡片活动`),
  );
  const report =
    '# Board report — 看板记录\n\n' +
    'Unicode **progress**: 卡片已核对，下一步继续。 🚀\n\n'.repeat(1800) +
    'Board report end — 完整记录。';
  const activity = await tui.transcriptResource('board-activity', {
    blocks: [
      ...history,
      note('report', report),
      ...['cards', 'notes'].map(
        (name) =>
          /** @type {Block} */ ({
            key: { turn: 'board-activity', message: `read-${name}`, part: 'tool' },
            revision: '1',
            kind: 'tool',
            state: 'returned',
            affinity: 'read',
            content: { text: `Read ${name}\nBoard ${name} checked.` },
          }),
      ),
      { ...note('live', 'Live activity — ready.\n'), key: liveKey },
    ],
    timings: [{ turn: 'board-activity', start_ms: Date.now(), active: true }],
  });
  ctx.effect(() => activity.close());
  let activityRevision = 1;
  let viewReads = 0;
  let activityViewReads = 0;
  let viewWrites = 0;
  let operationSequence = 0;
  await ctx.remote.method('activity-append', (input) => {
    activity.append(liveKey, String(input), String(++activityRevision));
    return activityRevision;
  });
  await ctx.remote.method('activity-stats', () => ({
    ...activity.stats,
    viewReads,
    activityViewReads,
    viewWrites,
    reportBytes: new TextEncoder().encode(report).length,
  }));
  const changed = await tui.changes('board-changed');
  /** Writes the whole board if nobody wrote it since `revision`.
   * @param {number | null} revision
   * @param {Card[]} cards
   * @param {{operation: string, input: string} | null} receipt
   */
  const store = async (revision, cards, receipt = null) => {
    await ctx.storage.batch([
      { key: 'cards', expectedRevision: revision, data: { kind: 'present', value: { cards } } },
      ...(receipt
        ? [
            {
              key: `move:${receipt.operation}`,
              expectedRevision: null,
              data: { kind: /** @type {const} */ ('present'), value: { input: receipt.input } },
            },
          ]
        : []),
    ]);
    viewWrites++;
    changed();
  };
  /** A card identity no card on the board has. @param {Card[]} cards */
  const fresh = (cards) =>
    `c${Math.max(0, ...cards.map((item) => Number(item.id.slice(1)) || 0)) + 1}`;

  /** @param {import('../../../../../packages/plugin-sdk/src/host.js').TerminalRequest} submission
   * @param {import('../../../../../packages/plugin-sdk/src/host.js').TerminalBackendContext} cx
   * @param {'board' | 'card' | 'create'} panel
   */
  const backend = async (submission, cx, panel) => {
    if (submission.kind === 'recover') {
      const route = submission.route;
      const operation =
        route && typeof route === 'object' && 'operation' in route ? route.operation : null;
      if (typeof operation !== 'string') return { kind: /** @type {const} */ ('unrecorded') };
      const receipt = await ctx.storage.read(`move:${operation}`);
      return receipt?.data.kind === 'present'
        ? { kind: /** @type {const} */ ('applied'), route: null }
        : { kind: /** @type {const} */ ('unrecorded') };
    }
    if (submission.kind === 'read') {
      viewReads++;
      const route = submission.route;
      const operation = `${cx.caller.documentId}:${++operationSequence}`;
      if (
        panel === 'board' &&
        route &&
        typeof route === 'object' &&
        'activity' in route &&
        route.activity === true
      ) {
        activityViewReads++;
        return { revision: null, cards: [], activity: activity.resource, panel, operation };
      }
      return { ...(await load()), activity: null, panel, operation };
    }
    const input = JSON.stringify({
      revision: submission.revision,
      action: submission.action,
      fields: submission.fields,
    });
    const operation = String(submission.fields.operation ?? '');
    if (submission.action === 'move') {
      if (!operation || operation.length > 128)
        return { kind: /** @type {const} */ ('rejected'), message: 'Invalid move identity' };
      const old = await ctx.storage.read(`move:${operation}`);
      if (old?.data.kind === 'present') {
        const receipt = /** @type {{input: string}} */ (old.data.value);
        return receipt.input === input
          ? { kind: /** @type {const} */ ('applied'), route: null }
          : { kind: /** @type {const} */ ('rejected'), message: 'Move identity was reused' };
      }
    }
    const { revision, cards } = await load();
    if (String(revision ?? 0) !== submission.revision)
      return { kind: /** @type {const} */ ('conflict') };
    const route = submission.route;
    const id = route && typeof route === 'object' && 'cardId' in route ? route.cardId : null;
    switch (submission.action) {
      case 'add': {
        const title = String(submission.fields.new ?? '').trim();
        if (!title)
          return {
            kind: /** @type {const} */ ('rejected'),
            message: cx.t('Name the card.', '请填写卡片名称。', '請填寫卡片名稱。'),
          };
        await store(revision, [...cards, { id: fresh(cards), title, column: 'todo', note: '' }]);
        return { kind: /** @type {const} */ ('applied'), route: submission.route };
      }
      case 'save':
        if (!cards.some((card) => card.id === id))
          return { kind: /** @type {const} */ ('conflict') };
        await store(
          revision,
          cards.map((item) =>
            item.id === id
              ? {
                  ...item,
                  title: String(submission.fields.title).trim() || item.title,
                  note: String(submission.fields.note),
                }
              : item,
          ),
        );
        return { kind: /** @type {const} */ ('applied'), route: submission.route };
      case 'move': {
        const item = cards.find((card) => card.id === submission.fields.item);
        const group = /** @type {Column} */ (submission.fields.group);
        const before = String(submission.fields.before);
        if (
          !item ||
          !columns.includes(group) ||
          (before &&
            (before === item.id ||
              !cards.some((card) => card.id === before && card.column === group)))
        ) {
          return { kind: /** @type {const} */ ('rejected'), message: 'Invalid card destination' };
        }
        const remaining = cards.filter((card) => card.id !== item.id);
        const at = before ? remaining.findIndex((card) => card.id === before) : remaining.length;
        remaining.splice(at, 0, { ...item, column: group });
        await store(revision, remaining, { operation, input });
        return { kind: /** @type {const} */ ('applied'), route: submission.route };
      }
      case 'delete':
        await store(
          revision,
          cards.filter((item) => item.id !== id),
        );
        return { kind: /** @type {const} */ ('applied'), route: submission.route };
      default:
        return { kind: /** @type {const} */ ('rejected'), message: 'Unknown action' };
    }
  };
  for (const panel of /** @type {const} */ (['board', 'card', 'create'])) {
    await tui.app(
      panel === 'board' ? 'board' : `board-${panel}`,
      {
        entry: 'board-ui.mjs',
        resources: panel === 'board' ? [activity.resource] : [],
        backend: (submission, cx) => backend(submission, cx, panel),
      },
      {
        title: {
          fallback: panel === 'board' ? 'Board' : panel === 'card' ? 'Card details' : 'New card',
          translations: {
            'zh-CN': panel === 'board' ? '看板' : panel === 'card' ? '卡片详情' : '新卡片',
            'zh-TW': panel === 'board' ? '看板' : panel === 'card' ? '卡片詳情' : '新卡片',
          },
        },
        context: 'application',
        icon: { glyph: '▦', ascii: 'B' },
        changes: 'board-changed',
        ...(panel === 'board'
          ? {}
          : { placement: { kind: /** @type {const} */ ('slot'), name: `board.${panel}` } }),
      },
    );
  }

  // Another writer: anything that adds a card through the plugin's API.
  await ctx.remote.method('add', async (input) => {
    const { revision, cards } = await load();
    await store(revision, [
      ...cards,
      { id: fresh(cards), title: String(input), column: 'todo', note: '' },
    ]);
    return (await load()).cards.length;
  });
  await ctx.remote.method('cards', async () => (await load()).cards);
}
