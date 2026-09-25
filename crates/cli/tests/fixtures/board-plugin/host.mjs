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
  await ctx.remote.method('activity-append', (input) => {
    activity.append(liveKey, String(input), String(++activityRevision));
    return activityRevision;
  });
  await ctx.remote.method('activity-stats', () => ({
    ...activity.stats,
    viewReads,
    activityViewReads,
    reportBytes: new TextEncoder().encode(report).length,
  }));
  const changed = await tui.changes('board-changed');
  /** Writes the whole board if nobody wrote it since `revision`.
   * @param {number | null} revision
   * @param {Card[]} cards
   */
  const store = async (revision, cards) => {
    await ctx.storage.batch([
      { key: 'cards', expectedRevision: revision, data: { kind: 'present', value: { cards } } },
    ]);
    changed();
  };
  /** @param {Column} column @param {number} step */
  const move = (column, step) =>
    columns[Math.min(2, Math.max(0, columns.indexOf(column) + step))] ?? column;
  /** A card identity no card on the board has. @param {Card[]} cards */
  const fresh = (cards) =>
    `c${Math.max(0, ...cards.map((item) => Number(item.id.slice(1)) || 0)) + 1}`;

  await tui.app(
    'board',
    {
      entry: 'board-ui.mjs',
      resources: [activity.resource],
      async backend(submission, cx) {
        if (submission.kind === 'read') {
          viewReads++;
          const route = submission.route;
          if (
            route &&
            typeof route === 'object' &&
            'activity' in route &&
            route.activity === true
          ) {
            activityViewReads++;
            return { revision: null, cards: [], activity: activity.resource };
          }
          return { ...(await load()), activity: null };
        }
        if (submission.kind !== 'submit') return { kind: 'unrecorded' };
        const { revision, cards } = await load();
        if (String(revision ?? 0) !== submission.revision) return { kind: 'conflict' };
        const route = submission.route;
        const id = route && typeof route === 'object' && 'card' in route ? route.card : null;
        switch (submission.action) {
          case 'add': {
            const title = String(submission.fields.new ?? '').trim();
            if (!title)
              return {
                kind: 'rejected',
                message: cx.t('Name the card.', '请填写卡片名称。', '請填寫卡片名稱。'),
              };
            await store(revision, [
              ...cards,
              { id: fresh(cards), title, column: 'todo', note: '' },
            ]);
            return { kind: 'applied', route: null };
          }
          case 'save':
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
            return { kind: 'applied', route: submission.route };
          case 'left':
          case 'right':
            await store(
              revision,
              cards.map((item) =>
                item.id === id
                  ? { ...item, column: move(item.column, submission.action === 'left' ? -1 : 1) }
                  : item,
              ),
            );
            return { kind: 'applied', route: null };
          case 'delete':
            await store(
              revision,
              cards.filter((item) => item.id !== id),
            );
            return { kind: 'applied', route: null };
          default:
            return { kind: 'rejected', message: 'Unknown action' };
        }
      },
    },
    {
      title: { fallback: 'Board', translations: { 'zh-CN': '看板', 'zh-TW': '看板' } },
      context: 'application',
      icon: { glyph: '▦', ascii: 'B' },
      changes: 'board-changed',
    },
  );

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
