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
  /** @type {Record<Column, [string, string, string]>} */
  const titles = {
    todo: ['To do', '待办', '待辦'],
    doing: ['Doing', '进行中', '進行中'],
    done: ['Done', '完成', '完成'],
  };
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
      async read(route, cx) {
        viewReads++;
        if (route && typeof route === 'object' && 'activity' in route && route.activity === true) {
          activityViewReads++;
          return {
            title: cx.t('Board activity', '看板活动', '看板活動'),
            revision: 'activity',
            root: tui.column('root', [
              tui.text(
                'intro',
                cx.t('Live board activity and history', '看板实时活动与历史', '看板即時活動與歷史'),
                'muted',
              ),
              tui.transcript('activity', activity.resource),
            ]),
          };
        }
        const { revision, cards } = await load();
        const stamp = String(revision ?? 0);
        const card =
          route &&
          typeof route === 'object' &&
          'card' in route &&
          cards.find((item) => item.id === route.card);
        if (card) {
          const index = columns.indexOf(card.column);
          const actions = [
            tui.action('save', cx.t('Save', '保存', '儲存'), { fields: ['title', 'note'] }),
            tui.action('delete', cx.t('Delete', '删除', '刪除'), {
              confirm: {
                title: cx.t('Delete this card?', '删除这张卡片？', '刪除這張卡片？'),
                message: cx.t(
                  'It leaves the board for good.',
                  '它会从看板上永久移除。',
                  '它會從看板上永久移除。',
                ),
                destructive: true,
              },
            }),
          ];
          const buttons = [tui.button('save', 'save', 'primary')];
          if (index > 0) {
            actions.push(tui.action('left', cx.t('Move back', '后退一列', '後退一欄')));
            buttons.push(tui.button('left', 'left'));
          }
          if (index < 2) {
            actions.push(tui.action('right', cx.t('Move on', '前进一列', '前進一欄')));
            buttons.push(tui.button('right', 'right'));
          }
          buttons.push(tui.button('delete', 'delete', 'destructive'));
          return {
            title: card.title,
            revision: stamp,
            fields: [tui.line('title', card.title, 200), tui.area('note', card.note, 4000)],
            actions,
            root: tui.column('root', [
              tui.text('column', cx.t(...titles[card.column]), 'accent'),
              tui.stack('form', [
                tui.input('title', 'title', cx.t('Title', '标题', '標題')),
                tui.input('note', 'note', cx.t('Note', '备注', '備註')),
              ]),
              tui.row('controls', buttons),
            ]),
          };
        }
        const lanes = columns.map((column) =>
          tui.column(
            column,
            [
              tui.spans('title', [
                [cx.t(...titles[column]), 'strong'],
                [`  ${cards.filter((item) => item.column === column).length}`, 'subtle'],
              ]),
              ...cards
                .filter((item) => item.column === column)
                .map((item) =>
                  tui.link(
                    `card-${item.id}`,
                    item.title,
                    { card: item.id },
                    item.note ? { detail: item.note } : {},
                  ),
                ),
            ],
            0,
          ),
        );
        return {
          title: cx.t('Board', '看板', '看板'),
          revision: stamp,
          fields: [
            tui.line('new', '', 200, { placeholder: cx.t('A new card', '新卡片', '新卡片') }),
          ],
          actions: [tui.action('add', cx.t('Add', '添加', '新增'), { fields: ['new'] })],
          root: tui.column('root', [
            tui.row('lanes', lanes),
            tui.rule('divider'),
            tui.row('adding', [
              tui.input('new', 'new', cx.t('Card', '卡片', '卡片')),
              tui.button('add', 'add', 'primary'),
            ]),
            tui.link('activity', cx.t('Board activity', '看板活动', '看板活動'), {
              activity: true,
            }),
          ]),
        };
      },
      async submit(submission, cx) {
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
